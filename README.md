# tkytel-registry

tkytel registry written in [Mantela](https://github.com/tkytel/mantela) (maintained by: Allianaab2m)

https://tkytel.github.io/tkytel-registry/mantela.json

[`mantela.json`](mantela.json) is the registry itself. [日本語は下にあります。](#日本語)

## How this registry is updated

1. It reads the `mantela.json` of every exchange listed in this registry's `providers`.
2. It collects the exchanges that are one hop from the registry.
3. For each of them it fetches that exchange's own `mantela.json` and registers it from that file's `aboutMe`.

The prefix is picked from `preferredPrefix`, among the values not already taken, preferring no leading zero, then fewer digits, then declared order.

If every declared value is taken, the exchange is not added and the conflict is reported instead.

## How to get listed

There is nothing you need to do here. Ask any exchange already in this registry to list you in its `providers`.

For that, your `mantela.json` has to be reachable over HTTP(S), and its `aboutMe` needs `name`, `identifier` and `preferredPrefix`.

## "Hey! Don't put me in your registry without asking!"

Sorry about that. It is a bother, we know, but please open an issue, or send a pull request adding yourself to [`denylist.json`](denylist.json):

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

- `identifier` and `mantela` — at least one is required. Both would be appreciated.
- `reason` — free text. Please leave enough for a later reader to follow how the request came about.
- `since` — the date of the request.

Once you are on that list, the updater will never add you, and will not even fetch your `mantela.json`.

If you are already in `providers`, the next run removes you, and that removal appears in that run's pull request.

It has no effect on other exchanges listing you in their own `providers`, though. That is between you and them.

One more thing: this registry does not read `aboutMe.unavailable` as a refusal to be listed.

## The updater

Source and details: [`cmd/updater`](cmd/updater).

---

## 日本語

[`mantela.json`](mantela.json) がレジストリ本体です。

### このレジストリの更新のしかた

1. このレジストリの `providers` に載っている各交換局の `mantela.json` を読みます。
2. レジストリから1ホップの局を集めます。
3. その各局について、局自身の `mantela.json` を取得し、`aboutMe` を登録します。

prefix は `preferredPrefix` のうち、まだ使われていないものから、先頭ゼロなし、桁数が短い、宣言順の順で選びます。

宣言された値が全部埋まっている局は追加せず、衝突として報告します。

### 掲載されたい場合

特にここで何かする必要はありません。すでにこのレジストリに載っている交換局のどれかに、自局を `providers` へ載せてもらってください。

そのためには `mantela.json` が HTTP(S) で取得できること、`aboutMe` に `name`・`identifier`・`preferredPrefix` があることが要件です。

### 「ちょっと！勝手にレジストリに登録しないでよ！」

申し訳ないです。大変お手数ではありますが、Issue を立てるか、[`denylist.json`](denylist.json) に自局を追加するプルリクエストを送ってください。

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

- `identifier` と `mantela` — どちらか一方は必須です。両方書いてもらえるとありがたいです。
- `reason` — 自由記述です。あとから読む人が経緯を追えるくらいには書いておいてください。
- `since` — 申し出のあった日付。

このリストに追加しておくと、updater は二度と追加しませんし、`mantela.json` を取得しにも行きません。

すでに `providers` に載っている場合は、次の実行で削除され、その削除もそのプルリクエストに出ます。

しかしながら、他の交換局が自分の `providers` にあなたを載せることには影響しません。それはあなたとその局の間の話です。

また、`aboutMe.unavailable` をこのレジストリは掲載拒否しているとは判断しません。

### updater について

ソースと詳細は [`cmd/updater`](cmd/updater) にあります。
