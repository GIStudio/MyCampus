# 数据与素材来源

## OpenStreetMap

两个校区的建筑、道路、水体、绿化与树木位置来自 OpenStreetMap，原始快照及派生 GeoJSON 按 ODbL 提供。

- 署名：© OpenStreetMap contributors
- 许可：https://www.openstreetmap.org/copyright
- ODbL：https://opendatacommons.org/licenses/odbl/1-0/

### 清水湾校区

- 校园边界：https://www.openstreetmap.org/way/40664120
- 下载范围：114.2615,22.3317,114.2700,22.3405（西、南、东、北）
- 快照：https://api.openstreetmap.org/api/0.6/map.json?bbox=114.2615,22.3317,114.27,22.3405
- 获取时间：2026-11-13T05:36:43.937Z
- 本地快照：`data/osm/clear-water-bay.osm.json`

### 广州校区

- 校园边界：https://www.openstreetmap.org/way/894157108
- 下载范围：113.4708,22.8829,113.4874,22.9008（西、南、东、北）
- 快照：https://api.openstreetmap.org/api/0.6/map.json?bbox=113.4708,22.8829,113.4874,22.9008
- 获取时间：2026-11-13T05:36:43.622Z
- 本地快照：`data/osm/guangzhou.osm.json`

建筑高度优先使用 OSM `height`，其次按 `building:levels × 3m` 估算，最后使用建筑类型默认值。`source=generated` 的树木是确定性程序示意，不是测绘树位。广州校区使用平面地形，清水湾使用下述公开高程数据。

## 清水湾地形

- 数据集：Mapzen / Tilezen Terrain Tiles，由 AWS Open Data 托管
- 数据集说明：https://registry.opendata.aws/terrain-tiles/
- 来源与许可说明：https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- 高程署名：SRTM data courtesy of the U.S. Geological Survey
- 原始数据：zoom 15 Terrarium PNG，保存于 `data/terrain/tiles/`
- 派生数据：`data/terrain/clear-water-bay.terrain.json`，获取时间记录于文件内

原始 RGB 按 Terrarium 公式解码为米制高程，双线性重采样为约 5 米网格。异常深负值使用邻域插值修复，近海负高程归零；原始 PNG 不修改。运行时派生地形另外将建筑占地平整到由各轮廓原始高程中位数确定的基座，并在周边 8 米内平滑过渡；这些平台和过渡带不属于原始 SRTM 数据。该地形用于风格化漫游，不是测绘级地形或建筑基础高程。

## 低模树木

- 作者：Kenney
- 素材包：Kenney Nature Kit
- 来源：https://kenney.nl/assets/nature-kit
- 许可：Creative Commons CC0
- 本地说明：`public/assets/ATTRIBUTION.md`
- 许可文本：`public/assets/CC0-LICENSE.txt`

仅重新打包实际使用的三个 GLB 模型：`tree-0.glb`、`tree-1.glb`、`tree-2.glb`。模型无外部纹理依赖。

## 原创程序化素材

方块漫游角色、像素面部、界面、程序化备用树木和三维场景几何由本项目代码生成；未使用 Minecraft 官方皮肤、商标素材或第三方校园模型。
