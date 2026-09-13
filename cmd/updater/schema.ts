import { Schema as S } from "effect"

/** 交換局の識別子。印字可能 ASCII のみで、空文字は不可 */
const Identifier = S.String.check(S.isPattern(/^[\x21-\x7E]+$/))

/**
 * プレフィクス番号。
 * "0113" や "0510" のように先頭ゼロを含むものが実在するので、数値にせず文字列のまま扱う。
 */
const Prefix = S.String.check(S.isPattern(/^[0-9]+$/))

/** mantela.json の URL。空文字や相対パスを弾くため http(s) の絶対 URL だけを通す */
const MantelaUrl = S.String.check(S.isPattern(/^https?:\/\/[^\s]+$/))

export const AboutMe = S.Struct({
  name: S.String,
  identifier: Identifier,
  preferredPrefix: S.optional(S.Union([S.Array(Prefix), Prefix])),
  unavailable: S.optional(S.Boolean),
})

export type AboutMe = typeof AboutMe.Type

export const Provider = S.Struct({
  identifier: Identifier,
  name: S.String,
  prefix: Prefix,
  mantela: MantelaUrl,
  unavailable: S.optional(S.Boolean),
})

export type Provider = typeof Provider.Type

/**
 * 他局から取得した mantela.json を読むための schema。
 *
 * 実際に配信されているファイルは版が揃っておらず、$schema と version はそれぞれ3種類が
 * 混在する。extensions[].identifier の欠落も多い。updater が要るのは aboutMe と
 * providers だけなので、その2つだけを型付けし、それ以外のキーは見ない。
 *
 * providers の各要素を Unknown で受けるのは、1件でも壊れたエントリがあると局まるごと
 * 取りこぼしてしまうため。要素は Provider で個別に decode し、通ったものだけを使う。
 */
export const Mantela = S.Struct({
  aboutMe: AboutMe,
  providers: S.Array(S.Unknown),
})

export type Mantela = typeof Mantela.Type

/**
 * 掲載を拒否している交換局。identifier と mantela URL のどちらか一方、または両方で指定する。
 *
 * 両方書けるようにしてあるのは、局が identifier を振り直したり配信先の URL を変えたりする
 * ことがあるため。片方が変わっても、もう片方で止まる。
 */
export const DenyEntry = S.Struct({
  identifier: S.optional(Identifier),
  mantela: S.optional(MantelaUrl),
  reason: S.String,
  since: S.String.check(S.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
})

export type DenyEntry = typeof DenyEntry.Type

export const Denylist = S.Struct({
  entries: S.Array(DenyEntry),
})
