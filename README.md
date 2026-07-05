# mc-channel-plugin

A **Claude Code channel plugin** that gives Claude a Minecraft body via [mineflayer](https://github.com/PrismarineJS/mineflayer). Events from the MC server are pushed to Claude in real time; Claude decides how to act.

Works with **modded servers** (Forge/Fabric 1.20.1) -- includes registry remapping, custom block/item ID resolution, and stateId learning from the BlockInfo Mod.

## Features

- **Combat & PvP** -- threat radar, auto-engage hostile mobs, flee-to-owner when low HP, PvP via mineflayer-pvp
- **Follow** -- pathfinder-based following with door handling, short-range teleport fallback
- **Mining** -- dig single blocks or chain-mine veins, auto-pick-up drops, tool selection
- **FTB Ultimine** -- server-side chain-breaking (requires FTB Ultimine mod on the server)
- **Inventory & Crafting** -- list/equip/drop items, craft recipes (client-side & server-recipe-request)
- **Container interaction** -- open chests/barrels/shulker boxes, take/deposit items
- **Viewer** -- prismarine-viewer for a browser-based 3D view of the bot's surroundings
- **Sneak toggle** -- persistent crouch for redstone / trapdoor work
- **Trinket / Curios management** -- equip accessories on modded servers (Trinkets / Curios API)
- **Gravestone recovery** -- auto-locate and open ForgottenGraves tombstones
- **Registry remapping** -- intercepts Forge/Fabric registry packets to resolve modded item/block IDs correctly
- **BlockInfo Mod integration** -- reads solid-table dumps for accurate pathfinding on modded blocks

## Dependencies

| Package | Purpose |
|---------|---------|
| `mineflayer` | MC bot framework |
| `mineflayer-pathfinder` | A* navigation |
| `mineflayer-pvp` | Combat logic |
| `prismarine-viewer` | 3D browser viewer |
| `canvas` | Viewer rendering |
| `@modelcontextprotocol/sdk` | MCP stdio transport |

### Server-side mod dependencies (optional)

- **FTB Ultimine** -- required for the `ultimine` (chain-breaking) tool
- **BlockInfo Mod** -- Fabric client mod that dumps block stateId/solidity tables for accurate pathfinding on modded blocks

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_HOST` | `localhost` | MC server address |
| `MC_PORT` | `25565` | MC server port |
| `MC_USERNAME` | `ChenYu_Bot` | Bot's in-game name |
| `MC_VERSION` | `1.20.1` | MC protocol version |
| `MC_OWNER_NAME` | `Player` | Player name for follow/flee-to-owner |

## Usage

This plugin is designed to run as a **Claude Code channel plugin** (stdio MCP server).

```bash
# Install dependencies
npm install

# Run standalone (for testing)
node server.js

# As a Claude Code channel plugin, add to your plugin config
# and Claude Code will launch it automatically
```

## Data files

| File | Purpose |
|------|---------|
| `item_dict.json` | Custom item display-name overrides |
| `stateid_cache.json` | Learned stateId-to-block-name mappings |
| `registry_mapping.json` | Cached Forge/Fabric registry remapping (auto-generated) |
| `blockinfo_solid.txt` | Block solidity table from BlockInfo Mod (user-provided) |

---

## 中文说明

Claude Code 的 Minecraft 频道插件——让 AI 通过 mineflayer 拥有一个 MC 身体，支持 mod 服（Forge/Fabric 1.20.1）。

### 主要功能

- **战斗走位** -- 自动识别敌怪（含mod怪）、走位闪避、跳劈暴击、危险方块规避、低血自动撤退
- **跟随** -- 寻路跟随玩家，保持舒适距离不挡操作，卡住自动传送
- **挖矿** -- 找矿/挖矿/自动捡掉落物，寻路失败自动传送兜底
- **FTB Ultimine 连锁破坏** -- 服务器装了 FTB Ultimine 即可一镐连挖整条矿脉/整棵树
- **prismarine-viewer 视觉** -- 浏览器打开 localhost:3007 看 bot 的第一人称画面
- **潜行** -- 深暗之域必备，急停也不会解除潜行
- **配饰管理** -- 支持 Trinkets/Curios mod 的配饰槽
- **容器交互** -- 开箱/取物/存物，安全传送不会卡墙
- **战力评估** -- 遇到 Warden 等 boss 自动劝退（force 参数可强制头铁）

### 配置

通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MC_HOST` | `localhost` | 服务器地址 |
| `MC_PORT` | `25565` | 服务器端口 |
| `MC_USERNAME` | `ChenYu_Bot` | Bot 游戏内名字 |
| `MC_VERSION` | `1.20.1` | MC 协议版本 |
| `MC_OWNER_NAME` | `Player` | 跟随/撤退的目标玩家名 |

### 服务端 mod 依赖（可选）

- **FTB Ultimine** -- 连锁破坏功能需要服务端安装此 mod
- **BlockInfo Mod** -- Fabric 客户端 mod，导出方块 stateId 对照表用于 mod 服寻路

## License

MIT
