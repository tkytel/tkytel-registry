import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Data, Effect, FileSystem, Path, Schedule, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Denylist, Mantela, Provider, type AboutMe, type DenyEntry } from "./schema"

class RegistryError extends Data.TaggedError("RegistryError")<{ message: string }> { }

class FetchError extends Data.TaggedError("FetchError")<{ url: string, message: string }> { }

/** その交換局を参照していた側の情報 */
type Ref = { readonly via: string, readonly entry: Provider }

/** 追加せずに見送った候補と、その理由 */
type Skipped = { readonly label: string, readonly reason: string }

/**
 * 比較用に URL を正規化する。スキームとホストの大文字小文字、既定ポートの違いを吸収する。
 * 正規化できないものは弾かれる前提なので、そのまま返す。
 */
const normalizeUrl = (url: string) => {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

/** 名前に改行が混ざっている局が実在するので、連続する空白は1つに畳む */
const normalizeName = (name: string) => name.replace(/\s+/g, " ").trim()

/** Markdown の表のセルに入れる */
const cell = (text: string) => normalizeName(text).replaceAll("|", "\\|")

const unique = <A>(values: Iterable<A>) => [...new Set(values)]

const code = (values: ReadonlyArray<string>) => values.map((v) => `\`${v}\``).join(", ")

/**
 * prefix の優先順位。registry に既にある27局の prefix はすべてこの順序で説明できる。
 * 先頭ゼロなしを優先し、次に桁数の短いものを優先する（"0113" より "113"、"2048" より "248"）。
 * 同順位は宣言順のまま（Array#sort が安定なので）。
 */
const byPreference = (a: string, b: string) =>
  (a.startsWith("0") ? 1 : 0) - (b.startsWith("0") ? 1 : 0) || a.length - b.length

const preferredPrefixes = (aboutMe: AboutMe): ReadonlyArray<string> =>
  aboutMe.preferredPrefix === undefined
    ? []
    : typeof aboutMe.preferredPrefix === "string"
      ? [aboutMe.preferredPrefix]
      : aboutMe.preferredPrefix

/** 参照元が名乗っていた prefix を、言及された回数の多い順に並べる */
const refPrefixes = (refs: ReadonlyArray<Ref>): ReadonlyArray<string> => {
  const counts = new Map<string, number>()
  for (const ref of refs) {
    counts.set(ref.entry.prefix, (counts.get(ref.entry.prefix) ?? 0) + 1)
  }
  return [...counts].sort(([, a], [, b]) => b - a).map(([prefix]) => prefix)
}

/**
 * registry 自身の mantela.json を読む。
 * 書き戻すときにキー順や extensions をそのまま残したいので、パース結果 (raw) も返す。
 */
const readRegistry = Effect.fn("readRegistry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const absolute = path.resolve(file)

  const text = yield* fs.readFileString(absolute).pipe(
    Effect.mapError((cause) => new RegistryError({ message: `${absolute} を読めない: ${cause}` })),
  )

  const raw = yield* Effect.try({
    try: () => JSON.parse(text) as { providers: Array<Record<string, unknown>> },
    catch: (cause) => new RegistryError({ message: `${absolute} が JSON として壊れている: ${cause}` }),
  })

  const { aboutMe, providers } = yield* Schema.decodeUnknownEffect(Mantela)(raw, { reportInput: true }).pipe(
    Effect.mapError((cause) => new RegistryError({ message: `${absolute} が Mantela として不正: ${cause}` })),
  )

  // registry 自身のファイルは手元で管理しているので、1件でも壊れていたら直すべきものとして落とす
  const entries = yield* Effect.forEach(providers, (provider, index) =>
    Schema.decodeUnknownEffect(Provider)(provider, { reportInput: true }).pipe(
      Effect.mapError((cause) => new RegistryError({ message: `${absolute} の providers[${index}] が不正: ${cause}` })),
    ))

  return { absolute, raw, aboutMe, entries }
})

/**
 * 掲載拒否のリストを読む。
 *
 * 既定では mantela.json と同じディレクトリの denylist.json を見て、無ければ空として扱う。
 * --denylist で明示されたときだけ、無いことをエラーにする。指定したファイルが読まれないまま
 * 拒否が素通りするのが一番まずい。
 */
const readDenylist = Effect.fn("readDenylist")(function* (file: string, required: boolean) {
  const fs = yield* FileSystem.FileSystem

  const exists = yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false)))
  if (!exists) {
    if (required) return yield* new RegistryError({ message: `${file} が無い` })
    return []
  }

  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError((cause) => new RegistryError({ message: `${file} を読めない: ${cause}` })),
  )

  const raw = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new RegistryError({ message: `${file} が JSON として壊れている: ${cause}` }),
  })

  const { entries } = yield* Schema.decodeUnknownEffect(Denylist)(raw, { reportInput: true }).pipe(
    Effect.mapError((cause) => new RegistryError({ message: `${file} が Denylist として不正: ${cause}` })),
  )

  for (const [index, entry] of entries.entries()) {
    if (entry.identifier === undefined && entry.mantela === undefined) {
      return yield* new RegistryError({
        message: `${file} の entries[${index}] に identifier も mantela も無い。どちらか一方は要る`,
      })
    }
  }

  return entries
})

/** denylist に載っているかを引く。identifier と mantela URL のどちらで一致しても拒否とみなす */
const makeDenied = (entries: ReadonlyArray<DenyEntry>) => {
  const byIdentifier = new Map<string, DenyEntry>()
  const byUrl = new Map<string, DenyEntry>()
  for (const entry of entries) {
    if (entry.identifier !== undefined) byIdentifier.set(entry.identifier, entry)
    if (entry.mantela !== undefined) byUrl.set(normalizeUrl(entry.mantela), entry)
  }
  return (provider: { identifier: string, mantela: string }) =>
    byIdentifier.get(provider.identifier) ?? byUrl.get(normalizeUrl(provider.mantela))
}

/**
 * 他局の mantela.json を取得する。
 * providers の要素は1件ずつ decode し、壊れているものだけを落とす。局まるごと捨てない。
 */
const fetchMantela = Effect.fn("fetchMantela")(function* (url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 2 }),
  )

  const json = yield* client.get(url).pipe(
    Effect.flatMap((response) => response.json),
    Effect.timeout(20_000),
    Effect.mapError((cause) => new FetchError({ url, message: `取得に失敗: ${cause}` })),
  )

  const mantela = yield* Schema.decodeUnknownEffect(Mantela)(json, { reportInput: true }).pipe(
    Effect.mapError((cause) => new FetchError({ url, message: `Mantela として読めない: ${cause}` })),
  )

  const [broken, entries] = yield* Effect.partition(mantela.providers, (provider) =>
    Schema.decodeUnknownEffect(Provider)(provider))

  return { url, aboutMe: mantela.aboutMe, entries, broken: broken.length }
})

/**
 * registry から1ホップ先にしかいない交換局を探し、providers に直接書けるところまで解決する。
 *
 * 手順は3段:
 *   1. registry が直接持つ局の mantela.json を取得する
 *   2. その providers のうち registry にまだ無いものを候補として集める
 *   3. 候補自身の mantela.json を取得し、aboutMe が名乗る名前と prefix を正とする
 *
 * 3段目を踏むのは、参照元によって同じ局の名前・prefix・URL の言うことが食い違うため。
 * 同時に、取得できない候補 (mantela URL が空、404 など) がここで落ちる。
 */
const resolveNewProviders = Effect.fn("resolveNewProviders")(function* (file: string, denylistFile: string, denylistRequired: boolean) {
  const registry = yield* readRegistry(file)
  const denied = makeDenied(yield* readDenylist(denylistFile, denylistRequired))

  // 掲載を拒否している局が既に載っていたら外す。以降はこの局が最初から居なかったものとして扱うので、
  // 押さえていた prefix も解放されるし、再発見されたときは拒否として報告される
  const removed: Array<{ index: number, entry: Provider, deny: DenyEntry }> = []
  const remaining: Array<Provider> = []
  for (const [index, entry] of registry.entries.entries()) {
    const deny = denied(entry)
    if (deny === undefined) remaining.push(entry)
    else removed.push({ index, entry, deny })
  }

  const knownIdentifiers = new Set([registry.aboutMe.identifier, ...remaining.map((e) => e.identifier)])
  const knownUrls = new Set(remaining.map((e) => normalizeUrl(e.mantela)))
  const takenPrefixes = new Set(remaining.map((e) => e.prefix))

  // 同じ局が prefix 違いで二重に載っていることがある (tkytel-8931 の 891 / 8931)。取得は URL 単位で1回でよい
  const targets = new Map<string, Provider>()
  for (const entry of remaining) {
    const url = normalizeUrl(entry.mantela)
    if (!targets.has(url)) targets.set(url, entry)
  }

  if (removed.length > 0) {
    yield* Console.error(`掲載拒否により ${removed.length} 局を providers から外す`)
  }

  yield* Console.error(`registry: ${remaining.length} 局を直接参照している (${targets.size} URL)`)

  const [directFailures, direct] = yield* Effect.partition(
    [...targets.values()],
    (entry) => fetchMantela(entry.mantela).pipe(Effect.map((mantela) => ({ entry, mantela }))),
    { concurrency: 8 },
  )

  yield* Console.error(`直接参照の取得: 成功 ${direct.length} / 失敗 ${directFailures.length}`)

  // 取得はできたが providers の一部が壊れている局。その先にいる交換局を取りこぼしている可能性がある
  const brokenEntries = direct
    .filter(({ mantela }) => mantela.broken > 0)
    .map(({ entry, mantela }) => ({ name: entry.name, url: entry.mantela, broken: mantela.broken }))

  // 候補は mantela URL 単位でまとめる。同じ局を別 identifier で指している参照が実在するため
  const candidates = new Map<string, { url: string, refs: Array<Ref> }>()
  const rejected: Array<Skipped> = []
  const blocked = new Map<string, Skipped>()

  for (const { entry: via, mantela } of direct) {
    for (const entry of mantela.entries) {
      if (knownIdentifiers.has(entry.identifier)) continue

      const url = normalizeUrl(entry.mantela)
      if (knownUrls.has(url)) continue

      // 拒否している局は取得もしに行かない
      const deny = denied(entry)
      if (deny !== undefined) {
        blocked.set(deny.identifier ?? deny.mantela ?? url, {
          label: `${normalizeName(entry.name)} (\`${entry.identifier}\`)`,
          reason: `${deny.reason} (${deny.since})`,
        })
        continue
      }

      const found = candidates.get(url)
      if (found === undefined) {
        candidates.set(url, { url: entry.mantela, refs: [{ via: via.name, entry }] })
      } else {
        found.refs.push({ via: via.name, entry })
      }
    }
  }

  yield* Console.error(`未登録の候補: ${candidates.size} URL`)

  const [candidateFailures, fetched] = yield* Effect.partition(
    [...candidates.values()],
    (candidate) => fetchMantela(candidate.url).pipe(Effect.map((mantela) => ({ candidate, mantela }))),
    { concurrency: 8 },
  )

  for (const failure of candidateFailures) {
    const refs = candidates.get(normalizeUrl(failure.url))?.refs ?? []
    rejected.push({
      label: `${normalizeName(refs[0]?.entry.name ?? "?")} (${failure.url})`,
      reason: `${failure.message} — 参照元: ${unique(refs.map((r) => r.via)).join(", ")}`,
    })
  }

  // 自己申告の identifier でまとめ直す。同じ局に別々の identifier が振られている参照があるので、
  // ここで初めて実体単位になる
  const resolved = new Map<string, { aboutMe: AboutMe, urls: Array<string>, refs: Array<Ref> }>()
  for (const { candidate, mantela } of fetched) {
    const found = resolved.get(mantela.aboutMe.identifier)
    if (found === undefined) {
      resolved.set(mantela.aboutMe.identifier, { aboutMe: mantela.aboutMe, urls: [candidate.url], refs: [...candidate.refs] })
    } else {
      found.urls.push(candidate.url)
      found.refs.push(...candidate.refs)
    }
  }

  const added: Array<{ entry: Provider, refs: Array<Ref>, notes: Array<string> }> = []
  const conflicts: Array<Skipped> = []

  // 多く参照されている局から順に prefix を割り当てる。新規どうしがぶつかったとき、
  // どちらが残るかを実行ごとにぶれさせないため
  const ordered = [...resolved.values()].sort((a, b) =>
    b.refs.length - a.refs.length || a.aboutMe.identifier.localeCompare(b.aboutMe.identifier))

  for (const { aboutMe, urls, refs } of ordered) {
    const via = unique(refs.map((r) => r.via)).join(", ")

    // 参照元が古い identifier を書いていた場合、拒否に引っかかるのは自己申告を見た後になる
    const deny = denied({ identifier: aboutMe.identifier, mantela: urls[0]! })
    if (deny !== undefined) {
      blocked.set(deny.identifier ?? deny.mantela ?? urls[0]!, {
        label: `${normalizeName(aboutMe.name)} (\`${aboutMe.identifier}\`)`,
        reason: `${deny.reason} (${deny.since})`,
      })
      continue
    }

    // 名乗った identifier が既知だった場合。参照元が誤った identifier を書いていたということなので、
    // 追加する必要はない
    if (knownIdentifiers.has(aboutMe.identifier)) {
      rejected.push({
        label: `${normalizeName(aboutMe.name)} (${urls[0]})`,
        reason: `自己申告の identifier \`${aboutMe.identifier}\` は登録済み。参照元 (${via}) が別の identifier で参照していた`,
      })
      continue
    }
    knownIdentifiers.add(aboutMe.identifier)

    const preferred = preferredPrefixes(aboutMe)
    const wanted = preferred.length > 0 ? preferred : refPrefixes(refs)
    const ranked = [...wanted].sort(byPreference)
    const prefix = ranked.find((p) => !takenPrefixes.has(p))

    if (prefix === undefined) {
      conflicts.push({
        label: `${normalizeName(aboutMe.name)} (\`${aboutMe.identifier}\`)`,
        reason: wanted.length === 0
          ? "prefix を決められない（preferredPrefix が無く、参照元も prefix を持たない）"
          : `希望する prefix (${code(wanted)}) がすべて使用済み — 参照元: ${via}`,
      })
      continue
    }
    takenPrefixes.add(prefix)

    // 参照数の多い URL を正とする。同じ局が複数の URL で配信されている場合がある
    const counts = new Map<string, number>()
    for (const ref of refs) {
      const url = normalizeUrl(ref.entry.mantela)
      counts.set(url, (counts.get(url) ?? 0) + 1)
    }
    const mantela = [...urls].sort((a, b) => (counts.get(normalizeUrl(b)) ?? 0) - (counts.get(normalizeUrl(a)) ?? 0))[0]!

    // 自己申告と参照元が食い違った点は、そのまま採用したうえでレビューに出す
    const notes: Array<string> = []
    const refPrefix = unique(refs.map((r) => r.entry.prefix))
    const refName = unique(refs.map((r) => normalizeName(r.entry.name)))
    const refIdentifier = unique(refs.map((r) => r.entry.identifier))

    if (preferred.length === 0) {
      notes.push("preferredPrefix が無いため参照元の prefix を採用")
    } else if (!refPrefix.includes(prefix)) {
      notes.push(`参照元は prefix ${code(refPrefix)} を使っているが、自己申告の \`${prefix}\` を採用`)
    }
    if (ranked[0] !== prefix) {
      notes.push(`第1希望の \`${ranked[0]}\` が使用済みのため \`${prefix}\` を採用`)
    }
    if (!refIdentifier.includes(aboutMe.identifier)) {
      notes.push(`参照元は identifier ${code(refIdentifier)} で参照しているが、自己申告の \`${aboutMe.identifier}\` を採用`)
    }
    if (!refName.includes(normalizeName(aboutMe.name))) {
      notes.push(`参照元は「${refName.join("」「")}」と呼んでいるが、自己申告の「${normalizeName(aboutMe.name)}」を採用`)
    }
    if (normalizeName(aboutMe.name) !== aboutMe.name) {
      notes.push("自己申告の名前に改行や連続空白が入っていたので畳んだ")
    }
    if (urls.length > 1) {
      notes.push(`mantela URL が複数あった (${urls.join(", ")})`)
    }

    added.push({
      entry: { identifier: aboutMe.identifier, name: normalizeName(aboutMe.name), prefix, mantela },
      refs,
      notes,
    })
  }

  return { registry, removed, added, conflicts, rejected, directFailures, brokenEntries, blocked: [...blocked.values()] }
})

type Resolution = Effect.Success<ReturnType<typeof resolveNewProviders>>

/** PR の本文にそのまま貼れる形のレポート */
const renderReport = (resolution: Resolution) => {
  const { removed, added, conflicts, rejected, directFailures, brokenEntries, blocked } = resolution
  const lines: Array<string> = []

  // この1行がそのままコミットの件名になる
  const headline = [
    added.length > 0 ? `1ホップ先にいた未登録の交換局 ${added.length} 局を追加` : undefined,
    removed.length > 0 ? `掲載を拒否している ${removed.length} 局を削除` : undefined,
  ].filter((part) => part !== undefined)

  lines.push(headline.length === 0
    ? "providers に変更はありません。"
    : `${headline.join("し、")}しました。`)

  if (removed.length > 0) {
    lines.push(
      "",
      `## 掲載拒否により削除した交換局 (${removed.length})`,
      "",
      "| prefix | 局名 | identifier | 理由 | 申し出 |",
      "| --- | --- | --- | --- | --- |",
    )
    for (const { entry, deny } of removed) {
      lines.push(`| \`${entry.prefix}\` | ${cell(entry.name)} | \`${entry.identifier}\` | ${cell(deny.reason)} | ${deny.since} |`)
    }
  }

  if (added.length > 0) {
    lines.push(
      "",
      `## 追加した交換局 (${added.length})`,
      "",
      "| prefix | 局名 | identifier | mantela | 発見元 |",
      "| --- | --- | --- | --- | --- |",
    )
    for (const { entry, refs } of added) {
      const via = unique(refs.map((r) => cell(r.via))).join(", ")
      lines.push(`| \`${entry.prefix}\` | ${cell(entry.name)} | \`${entry.identifier}\` | ${entry.mantela} | ${via} |`)
    }

    const noted = added.filter((a) => a.notes.length > 0)
    if (noted.length > 0) {
      lines.push("", "### 自己申告と参照元が食い違った箇所", "",
        "いずれも自己申告の preferredPrefix を採用しています。", "")
      for (const { entry, notes } of noted) {
        lines.push(`- **${cell(entry.name)}**`)
        for (const note of notes) lines.push(`  - ${note}`)
      }
    }
  }

  if (conflicts.length > 0) {
    lines.push("", `## prefix が衝突して追加しなかった (${conflicts.length})`, "",
      "prefix を確定させてから追加してください。", "")
    for (const { label, reason } of conflicts) lines.push(`- ${label}: ${reason}`)
  }

  if (rejected.length > 0) {
    lines.push("", `## Mantela を取得できず追加しなかった候補 (${rejected.length})`, "")
    for (const { label, reason } of rejected) lines.push(`- ${label}: ${reason}`)
  }

  if (directFailures.length > 0) {
    lines.push("", `## 直接参照している局のうち取得に失敗 (${directFailures.length})`, "",
      "この局の先にいる交換局は今回まったく探索できていません。", "")
    for (const failure of directFailures) lines.push(`- ${failure.url}: ${failure.message}`)
  }

  if (blocked.length > 0) {
    lines.push("", `## 掲載拒否により追加しなかった候補 (${blocked.length})`, "",
      "denylist.json に載っているため探索の対象外です。", "")
    for (const { label, reason } of blocked) lines.push(`- ${label}: ${reason}`)
  }

  if (brokenEntries.length > 0) {
    lines.push("", `## providers に壊れたエントリがある局 (${brokenEntries.length})`, "",
      "Mantela として読めないエントリは読み飛ばしています。その先の交換局は探索できていません。", "")
    for (const { name, url, broken } of brokenEntries) lines.push(`- ${cell(name)} (${url}): ${broken} 件`)
  }

  return lines.join("\n") + "\n"
}

const writeRegistry = Effect.fn("writeRegistry")(function* (resolution: Resolution) {
  const fs = yield* FileSystem.FileSystem
  const { registry, removed, added } = resolution

  const removedIndices = new Set(removed.map(({ index }) => index))
  registry.raw.providers = registry.raw.providers.filter((_, index) => !removedIndices.has(index))
  registry.raw.providers.push(...added.map(({ entry }) => ({ ...entry })))

  yield* fs.writeFileString(registry.absolute, JSON.stringify(registry.raw, null, 2) + "\n").pipe(
    Effect.mapError((cause) => new RegistryError({ message: `${registry.absolute} に書けない: ${cause}` })),
  )
})

const run = Effect.fn("run")(function* (
  file: string,
  options: { report?: string, denylist?: string, dryRun: boolean },
) {
  const path = yield* Path.Path
  const denylistFile = options.denylist ?? path.join(path.dirname(path.resolve(file)), "denylist.json")

  const resolution = yield* resolveNewProviders(file, denylistFile, options.denylist !== undefined)
  const report = renderReport(resolution)

  if (options.report !== undefined) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(options.report, report).pipe(
      Effect.mapError((cause) => new RegistryError({ message: `${options.report} に書けない: ${cause}` })),
    )
  }

  const changed = resolution.added.length + resolution.removed.length

  if (options.dryRun) {
    yield* Console.error("--dry-run のため mantela.json は更新していない")
  } else if (changed > 0) {
    yield* writeRegistry(resolution)
    yield* Console.error(
      `${resolution.registry.absolute}: ${resolution.added.length} 局を追記、${resolution.removed.length} 局を削除した`,
    )
  } else {
    yield* Console.error("変更が無いので mantela.json は更新していない")
  }

  yield* Console.log(report)

  return resolution
})

const usage = `使い方: bun run index.ts run <mantela.json> [--report <file>] [--denylist <file>] [--dry-run]

  registry の providers にいる各局の mantela.json を読み、そこにしかいない交換局
  （registry から1ホップ）を providers に追記する

  --report <file>    PR 本文用の Markdown レポートを書き出す（stdout にも出る）
  --denylist <file>  掲載拒否のリスト。既定は mantela.json と同じディレクトリの
                     denylist.json で、無ければ空として扱う
  --dry-run          mantela.json を更新せず、レポートだけ出す`

switch (Bun.argv[2]) {
  case "run": {
    const file = Bun.argv[3]
    const flags = Bun.argv.slice(4)
    if (file === undefined || file.startsWith("-")) {
      console.error(usage)
      process.exit(1)
    }

    const valueOf = (flag: string) => {
      const index = flags.indexOf(flag)
      if (index === -1) return undefined
      const value = flags[index + 1]
      if (value === undefined || value.startsWith("-")) {
        console.error(`${flag} にはファイルパスが要る`)
        process.exit(1)
      }
      return value
    }

    const report = valueOf("--report")
    const denylist = valueOf("--denylist")

    BunRuntime.runMain(
      run(file, { report, denylist, dryRun: flags.includes("--dry-run") }).pipe(
        Effect.provide(BunServices.layer),
        Effect.provide(BunHttpClient.layer),
      ),
    )
    break
  }
  default:
    console.error(usage)
    process.exit(1)
}
