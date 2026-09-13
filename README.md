# tkytel-registry

tkytel registry written in [Mantela](https://github.com/tkytel/mantela) (maintained by: Allianaab2m)

[`mantela.json`](mantela.json) is the registry itself. [日本語は下にあります。](#日本語)

## How this registry is updated

A GitHub Actions workflow runs every Monday at 03:17 JST, and on manual dispatch.

1. It reads the `mantela.json` of every exchange listed in this registry's `providers`.
2. It collects exchanges that appear in those files but not here — the ones that are one hop from the registry.
3. For each of them it fetches that exchange's own `mantela.json` and takes `aboutMe` as authoritative. The name, identifier and prefix come from what the exchange says about itself, not from what other exchanges say about it.

The prefix is picked from `preferredPrefix`, among the values not already taken, preferring no leading zero, then fewer digits, then declared order. If every declared value is taken, the exchange is not added and the conflict is reported instead.

The updater does not recurse. Each run pulls one ring closer.

The result is a pull request, never a direct commit. Every point where the exchange's self-description disagreed with what referring exchanges said is written into the PR body, so a human can see what was decided and why.

## How to get listed

Nothing to do here. Ask any exchange already in this registry to list you in its `providers`, and the next run will pick you up.

For that to work, your `mantela.json` has to be reachable over HTTP(S), and its `aboutMe` needs `name`, `identifier` and `preferredPrefix`. Entries that cannot be fetched are reported and skipped, not guessed at.

## How to refuse being listed

Open an issue, or send a pull request adding yourself to [`denylist.json`](denylist.json):

```json
{
  "entries": [
    {
      "identifier": "00000000-0000-0000-0000-000000000000",
      "mantela": "https://example.com/.well-known/mantela.json",
      "reason": "Requested by the operator (#12)",
      "since": "2026-09-13"
    }
  ]
}
```

- `identifier` and `mantela` — at least one is required. Giving both is safer: if you later change your identifier or move your file, the other one still holds.
- `reason` — free text. Please leave enough for a later reader to understand the request.
- `since` — the date of the request, `YYYY-MM-DD`.

Once you are on that list, the updater will never add you, and will not even fetch your `mantela.json`. If you are already in `providers`, the next run removes you and the removal appears in that run's pull request.

Two things this does not do. It has no effect on other exchanges that list you in their own `providers` — that is between you and them. And `aboutMe.unavailable` is not an opt-out: the Mantela spec defines it as temporarily unavailable, so this registry does not read it as a refusal.

## The updater

Source and details: [`cmd/updater`](cmd/updater).

---

## 日本語

[`mantela.json`](mantela.json) がレジストリ本体です。

### このレジストリの更新のしかた

GitHub Actions のワークフローが毎週月曜 03:17 JST と手動 dispatch で走ります。

1. このレジストリの `providers` に載っている各交換局の `mantela.json` を読みます。
2. そこには載っていてここには載っていない交換局、つまりレジストリから1ホップの局を集めます。
3. その各局について、局自身の `mantela.json` を取得し、`aboutMe` を正とします。名前・identifier・prefix は、他局がその局をどう呼んでいるかではなく、その局が自分を何と名乗っているかから採ります。

prefix は `preferredPrefix` のうち、まだ使われていないものから、先頭ゼロなし、桁数が短い、宣言順の順で選びます。宣言された値が全部埋まっている局は追加せず、衝突として報告します。

updater は再帰しません。1回の実行で1周ぶんだけ近づきます。

結果は必ずプルリクエストで、直接コミットはしません。局の自己申告と参照元の言い分が食い違った箇所は全部 PR の本文に書き出すので、何がどう決まったかを人が見てから判断できます。

### 掲載されたい場合

ここで何かする必要はありません。すでにこのレジストリに載っている交換局のどれかに、自局を `providers` へ載せてもらってください。次の実行で拾われます。

そのためには `mantela.json` が HTTP(S) で取得できること、`aboutMe` に `name`・`identifier`・`preferredPrefix` があることが要ります。取得できないものは報告して飛ばすだけで、こちらで推測して埋めることはしません。

### 掲載を拒否する場合

Issue を立てるか、[`denylist.json`](denylist.json) に自局を追加するプルリクエストを送ってください。

```json
{
  "entries": [
    {
      "identifier": "00000000-0000-0000-0000-000000000000",
      "mantela": "https://example.com/.well-known/mantela.json",
      "reason": "運用者本人からの申し出 (#12)",
      "since": "2026-09-13"
    }
  ]
}
```

- `identifier` と `mantela` — どちらか一方は必須です。両方書くほうが確実で、あとで identifier を振り直したりファイルの置き場所を変えたりしても、もう片方で止まります。
- `reason` — 自由記述です。あとから読む人が経緯を追えるくらいには書いてください。
- `since` — 申し出のあった日付を `YYYY-MM-DD` で。

このリストに載ると、updater は二度と追加しませんし、`mantela.json` を取得しにも行きません。すでに `providers` に載っている場合は、次の実行で削除され、その削除もそのプルリクエストに出ます。

できないことが2つあります。他の交換局が自分の `providers` にあなたを載せることには影響しません。それはあなたとその局の間の話です。もう1つ、`aboutMe.unavailable` は拒否の合図としては扱いません。Mantela の仕様では「一時的に利用できない」という意味なので、このレジストリはそれを掲載拒否とは読みません。

### updater について

ソースと詳細は [`cmd/updater`](cmd/updater) にあります。
