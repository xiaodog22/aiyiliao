# resources-seed —— 只能入库的二进制种子（2026-11-17）

## 为什么有这一层

`backend/deploy/resources/` 是**构建产物**，已被 `.gitignore` 排除：图片副本可由
`python tools/resource-import.py --write` 从 `miniprogram/` 包内源重新生成，换机器可再生。

但那 3 个演示视频（`wash-hands.mp4` / `measure-bp.mp4` / `stand-up.mp4`）**没有包内源**：
它们早已从包体里移出（主包禁音视频），只以"服务端副本"的形式存在于本机，
`resource_asset` 表里登记着对应的 `size` 与 `sha256`。

结果：干净 clone 上 `backend/deploy/resources/` 为空 →
`ResourceAssetService` 构造期 fail-fast（"资源目录不存在或不是目录"）→
`@SpringBootTest` 上下文全部起不来（2026-11-17 CI 实测 341 项里 256 项 error）；
即使目录存在但缺视频，`ResourceAssetTest` 也会 404。

## 这一层做什么

- 只放**无法从仓库其它位置再生**的二进制（当前就是上面 3 个 mp4）。
- 不参与小程序包体（不放 `miniprogram/packageContent/`，避免"音视频入包"）。
- CI 的 java job 在 `mvnw test` 之前把它们 `cp` 进 `backend/deploy/resources/`，
  再跑 `resource-import.py --write` 补齐图片副本——与 `docs` 里"部署前跑一次"同一口径。

## 同步约定

新增/替换服务端视频资源时：先放这里入库，再跑一次
`python tools/resource-import.py --write` 让 `deploy/resources/` 副本与 DB 的
`size`/`sha256` 对齐。三个文件的 `size` 必须与 `V14__resource_asset.sql` 登记值一致，
否则 `ResourceAssetTest` 的 sha256 断言会失败（这是有意的：宁可报错，不做静默兜底）。
