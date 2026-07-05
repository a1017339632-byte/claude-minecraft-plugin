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

## License

MIT
