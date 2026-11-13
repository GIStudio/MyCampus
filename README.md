# MyCampus

基于 Vite、TypeScript 与 Three.js 的 HKUST 清水湾校区 / HKUST(GZ) 双校区 3D 漫游，发布于 GitHub Pages。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm ci
npm run data:build
npm run dev
```

常用命令：

- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run build`：先类型检查，再生成 `dist/` 生产构建。
- `npm run preview`：本地预览生产构建。

## 数据刷新

```bash
npm run data:fetch
npm run data:build
```

`data:fetch` 获取并保存原始校园数据；`data:build` 将原始数据转换为前端使用的数据。部署工作流只执行 `data:build`，因此原始数据更新后应随项目一并提交。

## 部署

Vite 的公共基础路径固定为 `/MyCampus/`。推送 `main` 分支后，`.github/workflows/deploy.yml` 会安装依赖、构建校园数据与站点，并发布到 GitHub Pages；也可在 Actions 中手动运行。

首次发布前，请在仓库 **Settings → Pages → Build and deployment** 中将 **Source** 设为 **GitHub Actions**。
