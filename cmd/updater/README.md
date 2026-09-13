# updater

registry の `providers` に載っている各局の `mantela.json` を読み、そこにしかいない交換局
（registry から1ホップ）を `providers` に追記して0ホップにする。再帰はしない。

## 使い方

```bash
bun install
bun run index.ts run ../../mantela.json [--report <file>] [--dry-run]
```

- `--report <file>` PR 本文用の Markdown レポートを書き出す（stdout にも出る）
- `--dry-run` `mantela.json` を更新せず、レポートだけ出す

毎週月曜と手動 dispatch で `.github/workflows/update-registry.yml` が実行し、差分があれば
PR を出す。レポートがそのまま PR の本文になる。

## 何をしているか

1. registry が直接持つ局の `mantela.json` を取得する
2. その `providers` のうち registry にまだ無いものを候補として集める
3. 候補自身の `mantela.json` を取得し、`aboutMe` が名乗る名前と prefix を正とする

3段目を踏むのは、参照元によって同じ局の名前・prefix・URL の言うことが食い違うため。同じ局が
別々の identifier で参照されていることも、名前が古いままのこともある。自己申告でまとめ直すと
これが1件に潰れる。取得できない候補（`mantela` が空、404）もここで落ちる。

prefix は `preferredPrefix` のうち、衝突しないもので

1. 先頭ゼロなし
2. 桁数が短い
3. 宣言順

の順に選ぶ。この規則は registry の既存27局の prefix をすべて再現する（`["0113","113"]` → `113`、
`["248","2048"]` → `248`、`["108","119"]` で 108 が埋まっていれば `119`）。候補が全部埋まって
いる局は追加せず、レポートの警告に回す。

自己申告と参照元が食い違った箇所は、自己申告を採用したうえで全部レポートに出す。判断が要る
ものを黙って決めない。
