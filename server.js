#!/usr/bin/env node
/**
 * Minecraft Channel Plugin for Claude Code
 *
 * 琛屿的MC身体：mineflayer连MC服务器，事件推给Claude，Claude决定怎么做
 *
 * stdio MCP server ←→ Claude Code
 * mineflayer ←→ MC服务器
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const pvp = require("mineflayer-pvp").plugin;

const MC_HOST = process.env.MC_HOST || "localhost";
const MC_PORT = parseInt(process.env.MC_PORT || "25565");
const MC_USERNAME = process.env.MC_USERNAME || "ChenYu_Bot";
const MC_VERSION = process.env.MC_VERSION || "1.20.1";

const fs = require("fs");
const path = require("path");
const DEBUG_LOG = "/tmp/mc-debug.log";
const ITEM_DICT_PATH = path.join(__dirname, "item_dict.json");

function loadItemDict() {
  try { return JSON.parse(fs.readFileSync(ITEM_DICT_PATH, "utf8")); } catch { return {}; }
}
function saveItemDict(dict) {
  fs.writeFileSync(ITEM_DICT_PATH, JSON.stringify(dict, null, 2), "utf8");
}
function translateItem(name) {
  const dict = loadItemDict();
  const entry = dict[name];
  if (!entry) return name;
  if (typeof entry === "string") return entry;
  return entry.display_name || name;
}

let bot = null;
let mcp = null;
let msgSeq = 0;
let connected = false;
let registryMapping = null;
// bot世代计数(06-12)：每次createBot自增。旧bot的事件handler用gen对不上就直接return，
// 防止旧bot的end/kicked事件把新bot的connected改成false（"connect了好几次工具都说未连接"的根因）
let botGen = 0;
// registry映射持久化(06-12)：有些连接收不到registry包→整张物品表退回原版id（金锭显示成金镐）。
// 解析成功就存盘，spawn时发现本次没解析到→回放上次的存盘
const REGISTRY_MAPPING_PATH = path.join(__dirname, "registry_mapping.json");

// stateId自动学习缓存：从/data get block学到的 stateId → 真实方块名
const STATEID_CACHE_PATH = path.join(__dirname, "stateid_cache.json");
let stateIdCache = {};
function loadStateIdCache() {
  try { stateIdCache = JSON.parse(fs.readFileSync(STATEID_CACHE_PATH, "utf8")); } catch { stateIdCache = {}; }
}
function saveStateIdCache() {
  try { fs.writeFileSync(STATEID_CACHE_PATH, JSON.stringify(stateIdCache), "utf8"); } catch {}
}
loadStateIdCache();

// 方块固体性表：从 BlockInfo Mod 的 K 键 dump 出来。每行 "stateId,flag,blockId"
//   flag: 0=可穿过(空气/无碰撞) 1=满格固体 2=部分碰撞
// 一次解析两用：① solidTable 喂 pathfinder 认固体/空气 ② 顺手把 blockId 补全 stateIdCache（不用再按V一个个学）
// 纯 bot 读文件，不进 Claude 上下文
const SOLID_TABLE_PATH = path.join(__dirname, "blockinfo_solid.txt");
let solidTable = {};
function loadSolidTable() {
  try {
    const txt = fs.readFileSync(SOLID_TABLE_PATH, "utf8");
    const t = {};
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      const parts = s.split(",");
      if (parts.length < 2) continue;
      const sid = parseInt(parts[0]);
      if (isNaN(sid)) continue;
      t[sid] = parseInt(parts[1]);
      // 第三段是方块名 → 只合并进【内存】 stateIdCache，不覆盖按V实测学到的值。
      // ⚠️绝不 saveStateIdCache！这是96万条全集，写进持久文件会把精简的21KB撑成几十MB。
      // 名字只在内存里供 look_around / 报方块名用，每次启动从本表重建即可
      if (parts.length >= 3 && parts[2] && stateIdCache[sid] === undefined) {
        stateIdCache[sid] = parts.slice(2).join(",");
      }
    }
    solidTable = t;
  } catch { solidTable = {}; }
}
loadSolidTable();
let _gbDbg = 0; // 临时调试05-30：采样override getBlock
let _craftDbg = 0; // 临时调试05-31：craft v2s翻译采样
// 服务器配方缓存(declare_recipes包)：resultName → [{recipeId, type, ...}]
// 用于 craft_recipe_request 方案(绕过slot布局，让服务器自动放料)
let serverRecipes = {}; // e.g. {"bread": [{recipeId:"minecraft:bread", type:"minecraft:crafting_shaped"}]}

// itemId自动学习缓存：从BlockInfo Mod学到的 rawId → 真实物品名
const ITEMID_CACHE_PATH = path.join(__dirname, "itemid_cache.json");
let itemIdCache = {};
function loadItemIdCache() {
  try { itemIdCache = JSON.parse(fs.readFileSync(ITEMID_CACHE_PATH, "utf8")); } catch { itemIdCache = {}; }
}
function saveItemIdCache() {
  try { fs.writeFileSync(ITEMID_CACHE_PATH, JSON.stringify(itemIdCache), "utf8"); } catch {}
}
loadItemIdCache();

// 用/data get block查询真实方块名，结果写回blocksByStateId + 缓存
function learnBlockAt(x, y, z) {
  return new Promise((resolve) => {
    if (!bot || !connected) return resolve(null);
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 3000);
    function onSystem(data) {
      const msg = data.formattedMessage || "";
      if (!msg.includes("block data") && !msg.includes("Block") && !msg.includes("block_state")) return;
      const idMatch = msg.match(/"([a-z_][a-z0-9_]*:[a-z_][a-z0-9_/]*)"/);
      if (idMatch) {
        cleanup();
        const realName = idMatch[1];
        const block = bot.blockAt(require("vec3")(x, y, z));
        if (block && block.stateId !== undefined) {
          stateIdCache[block.stateId] = realName;
          const shortName = realName.replace("minecraft:", "");
          const vanillaData = bot.registry.blocksByName[shortName];
          bot.registry.blocksByStateId[block.stateId] = vanillaData || {
            id: block.stateId, name: realName, displayName: realName,
            hardness: 1, diggable: true, boundingBox: "block",
          };
          saveStateIdCache();
          log(`[learn] stateId ${block.stateId} = ${realName} (learned from /data)`);
        }
        resolve(realName);
      }
    }
    function cleanup() { clearTimeout(timeout); bot._client.off("systemChat", onSystem); }
    bot._client.on("systemChat", onSystem);
    safeChat(`/data get block ${x} ${y} ${z}`);
  });
}

// 启动时把缓存的stateId映射写回blocksByStateId
function applyCachedStateIds() {
  if (!bot || !bot.registry) return;
  let count = 0;
  for (const [sid, name] of Object.entries(stateIdCache)) {
    const id = parseInt(sid);
    const shortName = name.replace("minecraft:", "");
    const vanillaData = bot.registry.blocksByName[shortName];
    bot.registry.blocksByStateId[id] = vanillaData || {
      id, name, displayName: name, hardness: 1, diggable: true, boundingBox: "block",
    };
    count++;
  }
  if (count > 0) log(`[learn] applied ${count} cached stateId corrections`);
}

function applyCachedItemIds() {
  if (!bot || !bot.registry) return;
  let count = 0;
  for (const [rid, name] of Object.entries(itemIdCache)) {
    const id = parseInt(rid);
    const shortName = name.replace("minecraft:", "");
    const vanillaData = bot.registry.itemsByName[shortName];
    if (vanillaData) {
      bot.registry.items[id] = vanillaData.id === id ? vanillaData : { ...vanillaData, id }; // 克隆改id,同applyRegistryMapping
    } else {
      bot.registry.items[id] = { id, name, displayName: name, stackSize: 64 };
    }
    count++;
  }
  if (count > 0) {
    try { bot.registry.itemsArray = Object.values(bot.registry.items); } catch {} // 同applyRegistryMapping:itemsArray要跟items表同步
    log(`[learn] applied ${count} cached itemId corrections`);
  }
}

// === 任务中断/恢复系统（模块级，tool handlers需要访问）===
let currentTask = null;
let combatMode = false;
let combatTimeout = null;

function interruptTask() {
  if (currentTask && !currentTask.interrupted) {
    currentTask.interrupted = true;
    log(`[task] 任务被中断: ${currentTask.type}`);
  }
  combatMode = true;
  if (combatTimeout) clearTimeout(combatTimeout);
}

function endCombat() {
  combatTimeout = setTimeout(() => {
    combatMode = false;
    if (currentTask && currentTask.interrupted) {
      currentTask.interrupted = false;
      log(`[task] 脱战，任务可恢复: ${currentTask.type}`);
      notifyClaude(`[MC] 脱战了！之前的${currentTask.type}任务可以继续`, { event: "combat_end" });
    }
  }, 8000);
}

function nextId() {
  return `mc-${Date.now()}-${++msgSeq}`;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(`[mc-plugin] ${msg}\n`);
  fs.appendFileSync(DEBUG_LOG, line);
}

// ===== MC事件 → Claude通知 =====

function notifyClaude(content, extra = {}) {
  if (!mcp) return;
  const meta = {
    chat_id: "minecraft",
    message_id: nextId(),
    user: extra.user || "minecraft",
    user_id: extra.user_id || "mc-server",
    ts: new Date().toISOString(),
    ...extra,
  };

  log(`notify: ${content}`);
  const result = mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
  if (result && typeof result.then === "function") {
    result.catch((err) => log(`notification failed: ${err.message}`));
  }
}

// ===== 实体分类（06-12·mod怪识别）=====
// mod服实体type经常不可信（mod怪落进mob/other或name为undefined），用多信号分类。
// knownMobs提到模块级：打过我们的都是怪，跨重连记住。
const knownMobs = {};
const HOSTILE_RE = /zombie|skeleton|spider|creeper|enderman|witch|pillager|vindicator|evoker|vex|ravager|drowned|husk|stray|phantom|blaze|ghast|wither|piglin|hoglin|zoglin|warden|slime|magma|silverfish|shulker|guardian|breeze|bogged|mummy|ghoul|lich|stalker|reaper|spectre|wraith|demon|imp|corpse|skelet|undead|nightmare|forsaken|hollow|cursed|haunt|grimm|fallen|rotten|decay/i;
const PASSIVE_RE = /cow|sheep|pig\b|chicken|rabbit|horse|donkey|mule|llama|\bcat\b|wolf|fox|parrot|bee\b|axolotl|frog|goat|camel|sniffer|armadillo|allay|villager|golem|\bbat\b|squid|dolphin|turtle|panda|ocelot|mooshroom|strider|salamander|butterfly|duck|deer|owl|snail|moth|firefly|seahorse|crab/i;
// 实体真名：mod实体的name/displayName经常是undefined/"unknown"，用registry的entity_type表查(06-12)
function entityRealName(e) {
  if (e.name && e.name !== "unknown") return e.name;
  const regName = (registryMapping && registryMapping.entities && e.entityType !== undefined)
    ? registryMapping.entities[e.entityType] : null;
  return regName || e.name || e.displayName || e.type || "?";
}

function classifyEntity(e) {
  if (!e) return "ignore";
  if (e.type === "player") return "player";
  let n = `${e.name || ""} ${e.displayName || ""}`;
  // 实体表兜底(06-12)：名字全空/unknown时拿entity_type注册表的真名来判敌我
  if ((!e.name || e.name === "unknown") && registryMapping && registryMapping.entities && e.entityType !== undefined) {
    const regName = registryMapping.entities[e.entityType];
    if (regName) n += " " + regName;
  }
  if (e.name === "item" || e.type === "orb" || e.type === "projectile") return "ignore";
  if (e.name && knownMobs[e.name]) return "hostile";
  if (e.type === "hostile") return "hostile";
  if (HOSTILE_RE.test(n)) return "hostile";
  if (/hostile/i.test(e.kind || "")) return "hostile";
  if (e.type === "animal" || e.type === "water_creature" || e.type === "ambient") return "animal";
  if (PASSIVE_RE.test(n) || /passive/i.test(e.kind || "")) return "animal";
  if (e.type === "mob") return "unknown_mob"; // mod怪嫌疑：type是mob但名字认不出
  if (e.type === "object" || e.type === "other") return "other";
  return "unknown_mob"; // type都没有的，宁可错报当怪
}

// 打不过名单(2026-07-05 铁剑硬刚Warden死6次的学费)——attack不带force直接劝退,自动反击改逃跑。
// 往regex里加词就能维护。wither(?![_\s]?skelet)=wither本体算boss但wither_skeleton/Wither Skeleton不算。
const UNBEATABLE_RE = /warden|ender_dragon|wither(?![_\s]?skelet)|elder_guardian|(?:^|[_:\s])boss(?:[_:\s]|$)|leviathan|behemoth|colossus/i;
// 拿实体最大血量(server发过entity_update_attributes才有;mod怪不一定发,拿不到返回null只靠名单)
function getMaxHealth(e) {
  try {
    const attrs = e && e.attributes;
    if (!attrs) return null;
    const key = Object.keys(attrs).find((k) => /max_health/i.test(k));
    if (!key) return null;
    const v = attrs[key] && attrs[key].value;
    return typeof v === "number" && v > 0 ? v : null;
  } catch { return null; }
}

// 战斗走位/tp落点的危险方块名单(2026-07-05第四轮)——别风骚走位一步跨进岩浆。
// 先覆盖原版：岩浆/火/岩浆块/仙人掌/浆果丛/粉雪/营火/凋灵玫瑰。
// mod服的mod岩浆/尖刺/毒液类方块：拿到名字后往这个regex里用|加词即可(子串匹配,如|acid|spike)。
const DANGER_BLOCK_RE = /lava|magma_block|cactus|sweet_berry_bush|powder_snow|campfire|wither_rose|soul_fire|^fire$/i;

// ===== safeChat =====

function safeChat(msg) {
  if (!bot) return;
  try {
    if (typeof bot._client.chat === "function") {
      bot.chat(msg);
    } else if (msg.startsWith("/")) {
      bot._client.write("chat_command", {
        command: msg.slice(1),
        timestamp: BigInt(Date.now()),
        salt: 0n,
        argumentSignatures: [],
        messageCount: 0,
        acknowledged: Buffer.alloc(3),
      });
    } else {
      bot._client.write("chat_message", {
        message: msg,
        timestamp: BigInt(Date.now()),
        salt: 0n,
        offset: 0,
        acknowledged: Buffer.alloc(3),
      });
    }
  } catch (e) {
    log(`chat failed: ${e.message}`);
  }
}

// ===== FTB Ultimine 连锁破坏 (2026-07-05·协议已对源码核实) =====
// 服务器装了 FTB Ultimine(连锁破坏)。玩家客户端按住激活键(默认~)时发 key_pressed(true)，松开发 false；
// 服务端处理"方块被破坏"事件时若该玩家 pressed=true → 按 shape 连锁破坏整条矿脉/整棵树。
//
// 协议(对着 FTBTeam/FTB-Ultimine 分支 1.20.1/main + architectury-api 分支 1.20 源码核实过)：
//  - architectury SimpleNetworkManager 在 Fabric 上每条消息=独立 plugin channel(直接 ClientPlayNetworking.createC2SPacket(id,buf)，无包装无前缀)
//  - c2s channel "ftbultimine:key_pressed"：payload=1字节boolean(0x01按下/0x00松开)。服务端 handle→setKeyPressed(player,pressed)，【无客户端mod校验】
//  - c2s channel "ftbultimine:mode_changed"：payload=1字节boolean(next)，循环切 shape(shapeless→small_tunnel→…)。默认shape=shapeless(索引0)，一般不用切
//  - s2c "ftbultimine:send_shape" 等预览包 mineflayer 收到会当未知channel忽略，无害
//
// 服务端行为要点(源码确认)：
//  1. 连锁的起点/朝向来自【服务端对玩家视线的ray-trace】(FTBUltiminePlayerData.rayTrace)——bot挖时必须正看着那个方块。
//     mineflayer bot.dig() 默认 forceLook=true 会先看向方块，正好满足；但如果离得太远(≈5格,贴服务端reach上限)ray-trace可能miss→连不动，靠近点再挖
//  2. 饥饿=0(非创造)直接不给连；每多挖1块加exhaustion——连锁很费饥饿，挖前吃饱
//  3. 一次连锁上限=服务端配置 maxBlocks
function ultimineRegisterChannels() {
  // 模仿mod客户端在play阶段发 minecraft:register 声明频道(NUL分隔)。收c2s其实不要求注册，
  // 但注册了服务端 canSend 探测才认我们"能收"，保险且无害。每个bot连接只发一次。
  if (!bot || bot._ultimineRegistered) return;
  bot._ultimineRegistered = true;
  try {
    const chans = ["ftbultimine:key_pressed", "ftbultimine:mode_changed", "ftbultimine:send_shape", "ftbultimine:sync_config_from_server", "ftbultimine:edit_config", "ftbultimine:sync_ultimine_time"];
    bot._client.write("custom_payload", { channel: "minecraft:register", data: Buffer.from(chans.join("\0"), "utf8") });
    log(`[ultimine] 已发 minecraft:register 声明 ${chans.length} 个频道`);
  } catch (e) { log(`[ultimine] register err: ${e.message}`); }
}
function ultimineSetPressed(pressed) {
  if (!bot) return false;
  try {
    ultimineRegisterChannels();
    bot._client.write("custom_payload", { channel: "ftbultimine:key_pressed", data: Buffer.from([pressed ? 1 : 0]) });
    bot._ultiminePressed = !!pressed;
    log(`[ultimine] key_pressed=${pressed}`);
    return true;
  } catch (e) { log(`[ultimine] send err: ${e.message}`); return false; }
}

// ===== prismarine-viewer——bot的眼睛(2026-07-05第五轮) =====
// 起本机web服务(:3007),浏览器打开就是bot视角的3D渲染。渲染在浏览器端(three.js),
// 服务端只发方块/位置数据,内存友好(模块加载实测+27MB;serving期开销待实测)。
// 截图不归插件管:主session用Playwright browser_navigate到 http://localhost:3007,等3~5秒方块流完,再browser_take_screenshot。
// 1.20.1在prismarine-viewer@1.33.0官方支持列表(已验证);500mod服的mod方块渲染成紫黑missing texture属正常。
// ⚠️底线:lazy require(不开不吃内存)+所有入口catch——viewer坏了绝不能拖死MCP/bot连接。
let viewerWanted = false; // 开过就记住,断线重连spawn后自动试着重开一次
const VIEWER_PORT = 3007;
function startViewer() {
  try {
    if (!bot || !connected) return { ok: false, msg: "bot未连接,连上再开viewer" };
    if (bot.viewer && bot._viewerUp) return { ok: true, msg: `viewer已经开着: http://localhost:${VIEWER_PORT}` };
    // 防stdout污染:viewer的listen回调会console.log,而MCP走stdio,stdout杂质会搅坏JSON-RPC帧——
    // 第一次开viewer时把console.log永久改道到stderr日志(本插件自己不用console.log,无副作用)
    if (!global.__consoleToStderr) {
      global.__consoleToStderr = true;
      console.log = (...a) => { try { log("[stdout→] " + a.map(String).join(" ")); } catch {} };
    }
    const pv = require("prismarine-viewer"); // lazy require
    if (pv.supportedVersions && !pv.supportedVersions.includes(MC_VERSION)) {
      return { ok: false, msg: `prismarine-viewer不支持${MC_VERSION}(支持: ${pv.supportedVersions.join(",")})` };
    }
    pv.mineflayer(bot, { port: VIEWER_PORT, viewDistance: 4, firstPerson: true });
    bot._viewerUp = true;
    viewerWanted = true;
    log(`[viewer] started :${VIEWER_PORT}`);
    return { ok: true, msg: `viewer已启动: http://localhost:${VIEWER_PORT} (第一人称,viewDistance=4)。Playwright打开这个地址等3~5秒再截图,就是我眼前的画面` };
  } catch (e) {
    log(`[viewer] start失败: ${e.message}`);
    return { ok: false, msg: `viewer启动失败(不影响bot本体): ${e.message}` };
  }
}
function stopViewer(keepWanted) {
  try {
    if (bot && bot.viewer) {
      try { bot.viewer.close(); } catch (e) { log(`[viewer] close err: ${e.message}`); }
      bot._viewerUp = false;
    }
  } catch {}
  if (!keepWanted) viewerWanted = false;
}

// ===== 安全tp到方块旁(2026-07-06·开箱tp进墙闷死的学费) =====
// 旧的"找箱子旁空气位"用 block.name==="air" 判空气——mod方块在vanilla表里名字经常读成"air"，
// 实际是实心方块，于是把墙里当"安全位"，tp进去每0.5秒1血从19闷到0(suffocated in a wall)。
// 统一走findSafeLanding(stateIdCache真名+两格空气+脚下实心非危险)：四邻列→自身列(站方块头顶)。
// 找不到安全落点→返回null，【调用方绝不能硬tp】，报错让玩家/主session自己决定走过去。
function tpNearBlockSafe(bx, by, bz, label) {
  if (!bot || typeof bot._findSafeLanding !== "function") return null;
  let land = null;
  for (const [cx, cz] of [[bx + 1, bz], [bx - 1, bz], [bx, bz + 1], [bx, bz - 1], [bx, bz]]) {
    land = bot._findSafeLanding(cx, by, cz);
    if (land) break;
  }
  if (!land) { log(`[safe-tp] ${label || ""}(${bx},${by},${bz})四邻找不到安全落点,拒绝tp`); return null; }
  safeChat(`/tp ${MC_USERNAME} ${land.x} ${land.y} ${land.z}`);
  log(`[safe-tp] ${label || ""}→(${land.x},${land.y},${land.z})`);
  return land;
}

// ===== 装备武器 =====

function equipBestWeapon() {
  const dominated = [
    "netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword",
    "netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe",
  ];
  for (const name of dominated) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) {
      bot.equip(item, "hand").catch(() => {});
      return name;
    }
  }
  return null;
}

// 按方块名兜底选工具(06-12)：mod方块registry是合成条目,没material/harvestTools数据,
// pathfinder的bestHarvestTool算不出→徒手抠石头。按名字猜工具类型+材质从好到差挑
function pickToolByName(block) {
  if (!bot) return null;
  const n = ((block && (stateIdCache[block.stateId] || block.name)) || "").toLowerCase();
  let kind = null;
  if (/ore|stone|cobble|deepslate|granite|andesite|diorite|obsidian|furnace|anvil|brick|concrete|terracotta|basalt|blackstone|netherrack/.test(n)) kind = "pickaxe";
  else if (/log|wood|plank|fence|_door|crafting|chest|bookshelf|leaves/.test(n)) kind = "axe";
  else if (/dirt|sand|gravel|grass_block|clay|soul_|podzol|mycelium|snow|mud/.test(n)) kind = "shovel";
  if (!kind) return null;
  const tiers = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
  const cands = bot.inventory.items().filter((i) => i.name.includes(kind));
  cands.sort((a, b) => {
    const ta = tiers.findIndex((t) => a.name.includes(t));
    const tb = tiers.findIndex((t) => b.name.includes(t));
    return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
  });
  return cands[0] || null;
}

// ===== Fabric Registry解析 =====

function readVarInt(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, size: pos - offset };
    shift += 7;
    if (shift >= 32) break;
  }
  return null;
}

function readString(buf, offset) {
  const lenResult = readVarInt(buf, offset);
  if (!lenResult) return null;
  const strLen = lenResult.value;
  const start = offset + lenResult.size;
  if (start + strLen > buf.length) return null;
  return { value: buf.toString("utf8", start, start + strLen), size: lenResult.size + strLen };
}

function parseFabricRegistry(buf) {
  log(`[registry] parsing fabric registry sync data: ${buf.length} bytes`);
  // 06-12加entity_type/menu(认mod怪+开mod箱) 06-13加enchantment/mob_effect/fluid/villager×2/painting(煊煊说"又不进你上下文,塞呗")
  const mapping = { blocks: {}, items: {}, entities: {}, menus: {}, enchantments: {}, effects: {}, fluids: {}, professions: {}, villagerTypes: {}, paintings: {} };
  let pos = 0;
  let registryCount = 0;

  try {
    const regNsGroupCount = readVarInt(buf, pos);
    if (!regNsGroupCount) { log("[registry] failed to read regNsGroupCount"); return; }
    pos += regNsGroupCount.size;

    for (let rng = 0; rng < regNsGroupCount.value && pos < buf.length; rng++) {
      const regNs = readString(buf, pos);
      if (!regNs) break;
      pos += regNs.size;
      const actualRegNs = regNs.value || "minecraft";

      const regCount = readVarInt(buf, pos);
      if (!regCount) break;
      pos += regCount.size;

      for (let r = 0; r < regCount.value && pos < buf.length; r++) {
        const regPath = readString(buf, pos);
        if (!regPath) break;
        pos += regPath.size;
        const fullRegName = actualRegNs + ":" + regPath.value;
        registryCount++;
        log(`[registry] 表${registryCount}: ${fullRegName}`); // 06-13:煊煊问"还给了什么表"——全部打出来

        const isBlock = fullRegName === "minecraft:block";
        const isItem = fullRegName === "minecraft:item";
        const isEntity = fullRegName === "minecraft:entity_type"; // 06-12:认mod怪用
        const isMenu = fullRegName === "minecraft:menu"; // 06-12:开mod箱子的窗口类型用
        const isEnchant = fullRegName === "minecraft:enchantment"; // 06-13:看懂附魔书
        const isEffect = fullRegName === "minecraft:mob_effect"; // 06-13:看懂药水效果
        const isFluid = fullRegName === "minecraft:fluid"; // 06-13:别把mod酸液当水游
        const isProfession = fullRegName === "minecraft:villager_profession";
        const isVillagerType = fullRegName === "minecraft:villager_type";
        const isPainting = fullRegName === "minecraft:painting_variant";

        const entryNsGroupCount = readVarInt(buf, pos);
        if (!entryNsGroupCount) break;
        pos += entryNsGroupCount.size;

        let entryTotal = 0;
        let lastBulkLastRawId = 0;

        for (let eng = 0; eng < entryNsGroupCount.value && pos < buf.length; eng++) {
          const entryNs = readString(buf, pos);
          if (!entryNs) break;
          pos += entryNs.size;
          const actualEntryNs = entryNs.value || "minecraft";

          const bulkCount = readVarInt(buf, pos);
          if (!bulkCount) break;
          pos += bulkCount.size;

          for (let b = 0; b < bulkCount.value && pos < buf.length; b++) {
            const startDiff = readVarInt(buf, pos);
            if (!startDiff) break;
            pos += startDiff.size;
            const bulkSize = readVarInt(buf, pos);
            if (!bulkSize) break;
            pos += bulkSize.size;

            let currentRawId = (lastBulkLastRawId + startDiff.value) - 1;

            for (let e = 0; e < bulkSize.value && pos < buf.length; e++) {
              currentRawId++;
              const entryPath = readString(buf, pos);
              if (!entryPath) break;
              pos += entryPath.size;

              const fullEntryName = actualEntryNs + ":" + entryPath.value;
              if (isBlock) mapping.blocks[currentRawId] = fullEntryName;
              if (isItem) mapping.items[currentRawId] = fullEntryName;
              if (isEntity) mapping.entities[currentRawId] = fullEntryName;
              if (isMenu) mapping.menus[currentRawId] = fullEntryName;
              if (isEnchant) mapping.enchantments[currentRawId] = fullEntryName;
              if (isEffect) mapping.effects[currentRawId] = fullEntryName;
              if (isFluid) mapping.fluids[currentRawId] = fullEntryName;
              if (isProfession) mapping.professions[currentRawId] = fullEntryName;
              if (isVillagerType) mapping.villagerTypes[currentRawId] = fullEntryName;
              if (isPainting) mapping.paintings[currentRawId] = fullEntryName;
              entryTotal++;
            }
            lastBulkLastRawId = currentRawId;
          }
        }

        if (isBlock || isItem) {
          log(`[registry] ${fullRegName}: ${entryTotal} entries`);
        }
      }
    }

    log(`[registry] parsed ${registryCount} registries, blocks: ${Object.keys(mapping.blocks).length}, items: ${Object.keys(mapping.items).length}`);

    if (Object.keys(mapping.blocks).length > 0 || Object.keys(mapping.items).length > 0) {
      fs.writeFileSync("/tmp/mc-registry-mapping.json", JSON.stringify(mapping, null, 2));
      try { fs.writeFileSync(REGISTRY_MAPPING_PATH, JSON.stringify(mapping)); } catch (e) { log(`[registry] persist error: ${e.message}`); }
      log("[registry] mapping saved to /tmp/mc-registry-mapping.json + registry_mapping.json");
      applyRegistryMapping(mapping);
    }
  } catch (e) {
    log(`[registry] parse error at pos ${pos}: ${e.message}`);
  }
}

function applyRegistryMapping(mapping) {
  if (!bot || !bot.registry) {
    log("[registry] bot.registry not available, skipping apply");
    return;
  }
  try {
    let vanillaBlocks = 0, moddedBlocks = 0, itemCount = 0, moddedItems = 0;
    registryMapping = mapping;

    if (mapping.blocks && bot.registry.blocksByStateId) {
      const mcData = require("minecraft-data")(bot.version);

      // Sort blocks by rawId to compute stateIds correctly
      const sortedBlocks = Object.entries(mapping.blocks)
        .map(([id, name]) => [parseInt(id), name])
        .sort((a, b) => a[0] - b[0]);

      // Clear existing blocksByStateId to avoid stale entries
      const newBlocksByStateId = {};
      let currentStateId = 0;

      for (const [rawId, fullName] of sortedBlocks) {
        const parts = fullName.split(":");
        const shortName = parts.length > 1 ? parts[1] : parts[0];
        const namespace = parts.length > 1 ? parts[0] : "minecraft";

        // Look up vanilla block data for state count
        const vanillaBlock = (namespace === "minecraft") ? mcData.blocksByName[shortName] : null;
        let stateCount = 1;

        if (vanillaBlock) {
          stateCount = vanillaBlock.maxStateId - vanillaBlock.minStateId + 1;
          // Map all states for this vanilla block
          for (let s = 0; s < stateCount; s++) {
            const vanillaStateId = vanillaBlock.minStateId + s;
            const stateData = bot.registry.blocksByStateId[vanillaStateId];
            if (stateData) {
              newBlocksByStateId[currentStateId + s] = stateData;
            } else {
              newBlocksByStateId[currentStateId + s] = vanillaBlock;
            }
          }
          vanillaBlocks++;
        } else {
          // Modded block: assume 1 state, create synthetic entry
          newBlocksByStateId[currentStateId] = {
            id: rawId, name: fullName, displayName: fullName,
            hardness: 1, diggable: true, boundingBox: "block",
          };
          moddedBlocks++;
        }

        currentStateId += stateCount;
      }

      // Replace blocksByStateId
      bot.registry.blocksByStateId = newBlocksByStateId;
      log(`[registry] stateId mapping: ${vanillaBlocks} vanilla (${currentStateId} total states), ${moddedBlocks} modded`);
    }

    if (mapping.items && bot.registry.items) {
      for (const [rawId, name] of Object.entries(mapping.items)) {
        const id = parseInt(rawId);
        const shortName = name.replace("minecraft:", "");
        const itemData = bot.registry.itemsByName[shortName];
        if (itemData) {
          // 克隆+改id(06-13)：直接引用vanilla条目的话.id还是vanilla id,itemsArray.find(x=>x.id===服务器id)找不到
          bot.registry.items[id] = itemData.id === id ? itemData : { ...itemData, id };
          itemCount++;
        } else {
          bot.registry.items[id] = { id, name: name, displayName: name, stackSize: 64 };
          bot.registry.itemsByName[name] = bot.registry.items[id];
          moddedItems++;
        }
      }
    }
    log(`[registry] applied: ${vanillaBlocks} vanilla blocks, ${moddedBlocks} modded blocks, ${itemCount} vanilla items, ${moddedItems} modded items`);
    // itemsArray同步(06-13)：mineflayer取物品走registry.itemsArray.find(x=>x.id===type),
    // 只改items[id]不改数组→mod物品withdraw报"Invalid itemType"
    try { bot.registry.itemsArray = Object.values(bot.registry.items); } catch (e) { log(`[registry] itemsArray sync error: ${e.message}`); }
    bot._registryApplied = true; // spawn兜底回放用：标记本bot物品/方块表已remap
    // Apply cached corrections on top (learned from /data get block + BlockInfo Mod)
    applyCachedStateIds();
    applyCachedItemIds();
  } catch (e) {
    log(`[registry] apply error: ${e.message}`);
  }
}

// ===== 创建MC Bot =====

function createBot(host, port) {
  const gen = ++botGen; // 本bot的世代号，事件handler里对不上就说明自己是旧bot
  if (bot) {
    const old = bot;
    try { old.removeAllListeners(); } catch {}
    try { old.quit(); } catch {}
    // quit后兜底：3秒还没断干净就硬断socket+清协议层listener，别让旧bot的事件再漏进来
    setTimeout(() => {
      try { if (old._client) old._client.removeAllListeners(); } catch {}
      try { if (old._client && old._client.socket && !old._client.socket.destroyed) old._client.socket.destroy(); } catch {}
    }, 3000);
  }

  const useHost = host || MC_HOST;
  const usePort = port || MC_PORT;
  log(`connecting to ${useHost}:${usePort} as ${MC_USERNAME} (${MC_VERSION})`);

  bot = mineflayer.createBot({
    host: useHost,
    port: usePort,
    username: MC_USERNAME,
    version: MC_VERSION,
    hideErrors: true,
    locale: "zh_cn",
    // 06-12治"spawn后10秒timeout被踢"：登录区块洪峰(500mod调色板)把解析队列堵30秒+,
    // keepalive排队超时→服务器踢人。视距压小让洪峰可控(normal=289个区块列)。
    // 06-13 tiny(25列)→short(81列)：tiny只装载32格,煊煊一跑远实体就卸载→follow全靠tp。
    // short=64格,洪峰仍比normal小3.5倍;如果10秒踢复发→退回tiny
    viewDistance: "short",
  });

  // === TCP_NODELAY：禁用Nagle算法，防止SSH隧道缓冲keep-alive包导致超时 ===
  if (bot._client.socket) {
    bot._client.socket.setNoDelay(true);
    log("[tcp] setNoDelay(true) on existing socket");
  }
  bot._client.on("connect", () => {
    if (bot._client.socket) {
      bot._client.socket.setNoDelay(true);
      log("[tcp] setNoDelay(true) on connect");
    }
  });
  // keep-alive调试日志（保留观察）
  bot._client.on("keep_alive", (packet) => {
    log(`[keepalive] RECV id=${packet.keepAliveId} t=${Date.now()}`);
  });
  const _origWrite = bot._client.write.bind(bot._client);
  bot._client.write = function(name, data) {
    if (name === "keep_alive") {
      log(`[keepalive] SEND id=${data.keepAliveId} t=${Date.now()}`);
    }
    return _origWrite(name, data);
  };

  // === Registry拦截：捕获Forge/Fabric的registry sync数据 ===
  const registryData = { blocks: {}, items: {} };
  const registryChannels = [];
  const registryBuffers = {};

  bot._client.on("custom_payload", (packet) => {
    const ch = packet.channel || "";
    if (!registryChannels.includes(ch)) {
      registryChannels.push(ch);
      log(`[registry] custom_payload channel: ${ch} (data size: ${packet.data ? packet.data.length : 0})`);
    }
    if (ch.includes("registry") || ch.includes("forge") || ch.includes("fml")) {
      const dataLen = packet.data ? packet.data.length : 0;
      log(`[registry] REGISTRY CHANNEL: ${ch} data size: ${dataLen}`);
      if (dataLen > 0) {
        if (!registryBuffers[ch]) registryBuffers[ch] = [];
        registryBuffers[ch].push(Buffer.from(packet.data));
        const totalSize = registryBuffers[ch].reduce((s, b) => s + b.length, 0);
        log(`[registry] buffered ${registryBuffers[ch].length} parts, total: ${totalSize}`);
      }
      if (dataLen === 0 && registryBuffers[ch] && registryBuffers[ch].length > 0) {
        const merged = Buffer.concat(registryBuffers[ch]);
        const fname = `/tmp/mc-registry-${ch.replace(/[:/]/g, '_')}.bin`;
        try {
          fs.writeFileSync(fname, merged);
          log(`[registry] merged ${registryBuffers[ch].length} parts → ${fname} (${merged.length} bytes)`);
          if (ch.includes("fabric") && ch.includes("registry")) {
            parseFabricRegistry(merged);
          }
        } catch (e) {
          log(`[registry] save error: ${e.message}`);
        }
      }
    }
  });

  // 拦截login包获取dimensionCodec
  bot._client.on("login", (packet) => {
    log(`[registry] login packet received, dimensionCodec keys: ${packet.dimensionCodec ? Object.keys(packet.dimensionCodec).join(",") : "none"}`);
    try {
      fs.writeFileSync("/tmp/mc-dimension-codec.json", JSON.stringify(packet.dimensionCodec, null, 2));
      log("[registry] dimension codec saved to /tmp/mc-dimension-codec.json");
    } catch (e) {
      log(`[registry] dimension codec save error: ${e.message}`);
    }
  });

  // 在底层client上拦截deserialization错误，防止中断连接握手
  bot._client.on("error", (err) => {
    if (err.message && (err.message.includes("Deserialization") || err.message.includes("out of range") || err.message.includes("Bits per block"))) {
      log(`(client-level chunk/deserialization ignored, continuing...)`);
      return;
    }
    log(`client error: ${err.message}`);
  });

  // 关键修复：monkey-patch deserializer的_transform方法
  // deserializer在state变为"play"时才创建，用轮询确保尽早patch
  function patchDeserializer() {
    if (bot._client.deserializer) {
      bot._client.deserializer._transform = function(chunk, enc, cb) {
        try {
          const packet = this.parsePacketBuffer(chunk);
          if (packet.metadata.size !== chunk.length) {
            log(`(packet size mismatch, skipping)`);
          }
          // mod窗口类型重映射(05-31确诊)：mod自定义GUI的窗口type(如工作台=107)不在vanilla表里→
          // prismarine-windows.createWindow返null→mineflayer prepareWindow读null.id崩(同步push冒泡进此catch、
          // 被误记成"解析错误")→windowOpen永不触发→bot.craft/open_container等20s超时。修:按title把未知type映射成vanilla已知type(crafting=11)。
          try {
            if (packet && packet.data && packet.data.name === "open_window") {
              const _p = packet.data.params;
              if (_p && typeof _p.inventoryType === "number" && _p.inventoryType > 23) {
                const _t = String(_p.windowTitle || "");
                // 06-12升级：用registry的menu表查这个窗口类型的真名，按名字映射到最接近的vanilla类型
                const menuName = (registryMapping && registryMapping.menus && registryMapping.menus[_p.inventoryType]) || "";
                let mapped = null, why = "";
                const dim = menuName.match(/9x(\d)/) || _t.match(/9x(\d)/);
                if (/craft/i.test(menuName) || /craft/i.test(_t)) { mapped = 11; why = "crafting"; }
                else if (dim && +dim[1] >= 1 && +dim[1] <= 6) { mapped = +dim[1] - 1; why = `generic_9x${dim[1]}`; }
                else if (/shulker/i.test(menuName)) { mapped = 19; why = "shulker"; }
                else if (/furnace|smelt/i.test(menuName)) { mapped = 13; why = "furnace"; }
                else if (/hopper/i.test(menuName)) { mapped = 15; why = "hopper"; }
                else if (/chest|barrel|crate|storage|drawer|cabinet|loot/i.test(menuName + " " + _t)) { mapped = 2; why = "猜9x3(箱类)"; }
                if (mapped !== null) {
                  log(`[winfix] open_window invType=${_p.inventoryType}(${menuName || "?"})->${mapped}(${why}) title=${_t.slice(0, 40)}`);
                  _p.inventoryType = mapped;
                } else {
                  log(`[winfix] open_window 未知invType=${_p.inventoryType} menu=${menuName || "?"} title=${_t.slice(0, 40)} (没映射上)`);
                }
              }
            }
          } catch (_we) { log(`[winfix] err: ${_we.message}`); }
          this.push(packet);
          cb();
        } catch (e) {
          log(`(deserializer error skipped: ${e.message.substring(0, 80)})`);
          cb();
        }
      };
      log("deserializer patched: all parse errors non-fatal");
      return true;
    }
    return false;
  }

  // 轮询patch：每10ms检查deserializer是否存在，存在就立刻patch
  if (!patchDeserializer()) {
    const patchPoll = setInterval(() => {
      if (patchDeserializer()) {
        clearInterval(patchPoll);
      }
    }, 10);
    // 兜底：30秒后停止轮询
    setTimeout(() => clearInterval(patchPoll), 30000);
  }

  // 也监听state事件作为备份
  bot._client.on("state", (newState) => {
    log(`client state changed to: ${newState}`);
    if (newState === "play") {
      patchDeserializer();
    }
  });

  // [pktspy] 第1步逆向诊断05-31：抓craft期间bot发的window_click + 服务器回的窗口类包。
  // 用global.__pktSpy门控,只在craft时开,避免刷屏。验完删。
  try {
    const _origWrite = bot._client.write.bind(bot._client);
    bot._client.write = function (name, params) {
      if (global.__pktSpy && (name === "window_click" || name === "set_creative_slot" || name === "close_window" || name === "craft_recipe_request")) {
        try {
          const brief = name === "window_click"
            ? `win=${params.windowId} slot=${params.slot} btn=${params.mouseButton} mode=${params.mode} stateId=${params.stateId} changed=${(params.changedSlots||[]).length} cursor=${params.cursorItem ? (params.cursorItem.itemId ?? params.cursorItem.present) : "∅"}`
            : name === "craft_recipe_request"
            ? `win=${params.windowId} recipe=${params.recipe} makeAll=${params.makeAll}`
            : JSON.stringify(params).slice(0, 120);
          log(`[pktspy→S] ${name} ${brief}`);
        } catch (e) {}
      }
      return _origWrite(name, params);
    };
    const _spyIn = (nm) => (p) => {
      if (!global.__pktSpy) return;
      try {
        if (nm === "set_slot") log(`[pktspy←C] set_slot win=${p.windowId} slot=${p.slot} stateId=${p.stateId} item=${p.item ? (p.item.itemId ?? p.item.present) : "∅"}`);
        else if (nm === "window_items") log(`[pktspy←C] window_items win=${p.windowId} stateId=${p.stateId} count=${(p.items||[]).length}`);
        else if (nm === "transaction") log(`[pktspy←C] transaction win=${p.windowId} action=${p.action} accepted=${p.accepted}`);
        else if (nm === "acknowledge_player_digging") log(`[pktspy←C] ack_dig`);
        else log(`[pktspy←C] ${nm} ${JSON.stringify(p).slice(0,100)}`);
      } catch (e) {}
    };
    for (const nm of ["set_slot", "window_items", "transaction", "craft_recipe_response", "open_window"]) {
      bot._client.on(nm, _spyIn(nm));
    }
    log("[pktspy] hook装好(global.__pktSpy门控)");
  } catch (e) { log(`[pktspy] hook失败: ${e.message}`); }

  // [recipe-book] 监听 declare_recipes 包，缓存所有配方ID用于 craft_recipe_request
  // mod服的工作台ScreenHandler(type=107≠vanilla 11)导致bot.craft的slot操作被服务器静默拒绝，
  // 改用 craft_recipe_request 让服务器自己放料，完全绕过slot布局问题。
  try {
    bot._client.on("declare_recipes", (packet) => {
      serverRecipes = {};
      const mcData = require("minecraft-data")(bot.version);
      let count = 0;
      if (packet.recipes && Array.isArray(packet.recipes)) {
        for (const r of packet.recipes) {
          try {
            const recipeId = r.recipeId;
            const type = r.type;
            // 从data里提取result物品名
            let resultName = null;
            if (r.data) {
              // crafting_shaped / crafting_shapeless 的 result 是 slot 类型:
              // {present:true, itemId:<serverItemId>, itemCount:<n>, nbtData:...}
              const res = r.data.result;
              if (res && res.present && typeof res.itemId === "number") {
                // 查 registry 把 itemId 翻译成名字
                const regItem = bot.registry && bot.registry.items ? bot.registry.items[res.itemId] : null;
                if (regItem) resultName = regItem.name;
                else {
                  // fallback: 用 mcData (vanilla id可能对不上，但聊胜于无)
                  const vItem = mcData.items[res.itemId];
                  if (vItem) resultName = vItem.name;
                }
              }
              // smelting 等的 result 可能是 string 格式 (旧版本)
              if (!resultName && res && typeof res === "string") {
                resultName = res.replace("minecraft:", "");
              }
            }
            if (resultName) {
              if (!serverRecipes[resultName]) serverRecipes[resultName] = [];
              // 存完整配方信息：原料(ingredients) + 结果数量
              const entry = { recipeId, type };
              if (r.data) {
                // 提取原料列表：ingredients是数组，每个元素可能是单个slot或slot数组(多选材料)
                // shaped: r.data.ingredients是二维, shapeless: 一维
                const rawIngs = r.data.ingredients;
                if (rawIngs && Array.isArray(rawIngs)) {
                  entry.ingredients = [];
                  const flat = rawIngs.flat ? rawIngs.flat() : rawIngs;
                  for (const ing of flat) {
                    if (!ing) continue;
                    // ing可能是单个{type,count,id}或数组[{type,count,id},...]（多选材料取第一个）
                    const pick = Array.isArray(ing) ? ing[0] : ing;
                    if (pick && typeof pick === "object" && pick.id != null) {
                      const ingReg = bot.registry && bot.registry.items ? bot.registry.items[pick.id] : null;
                      const ingName = ingReg ? ingReg.name : (itemIdCache[pick.id] || `unknown_item_${pick.id}`);
                      entry.ingredients.push({ id: pick.id, name: ingName, count: pick.count || 1 });
                    }
                  }
                }
                // 结果数量
                if (r.data.result && r.data.result.itemCount) entry.resultCount = r.data.result.itemCount;
              }
              serverRecipes[resultName].push(entry);
              count++;
            }
          } catch (e) {}
        }
      }
      log(`[recipe-book] declare_recipes: ${count} 条配方已缓存 (${Object.keys(serverRecipes).length} 种物品)`);
      // 采样打几条看看
      const sample = Object.entries(serverRecipes).slice(0, 5);
      for (const [name, recs] of sample) {
        log(`[recipe-book] 采样: ${name} → ${recs.map(r => r.recipeId).join(", ")}`);
      }
    });
    log("[recipe-book] declare_recipes listener 已注册");
  } catch (e) { log(`[recipe-book] 注册失败: ${e.message}`); }

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);

  let spawnFired = false;

  bot.once("spawn", () => {
    if (gen !== botGen) { log(`[gen] 旧bot(gen${gen})的spawn事件，忽略`); return; }
    spawnFired = true;
    log("Bot spawned!");
    connected = true;
    notifyClaude("[MC] 琛屿已进入游戏世界！位置: " +
      Math.round(bot.entity.position.x) + "," +
      Math.round(bot.entity.position.y) + "," +
      Math.round(bot.entity.position.z));
    // viewer自动恢复:上次开着(viewerWanted)就在spawn稳定后重开一次;失败只报不重试,绝不拖累主流程
    setTimeout(() => {
      if (gen !== botGen || !connected || !viewerWanted) return;
      try {
        const r = startViewer();
        log(`[viewer] 重连自动恢复: ${r.msg}`);
        if (!r.ok) { viewerWanted = false; notifyClaude(`[MC] viewer重连恢复失败(${r.msg}),要看的话手动 viewer on`, { event: "viewer" }); }
      } catch (e) { log(`[viewer] 自动恢复异常: ${e.message}`); }
    }, 8000);
    // 延迟初始化：spawn后先让事件循环喘口气回复keep-alive，10秒后再做重活
    setTimeout(() => {
    if (gen !== botGen) return; // 延迟期间被新bot替换了
    // 自动设皮肤(煊煊要求) — 暂时关闭，新存档上传超时导致被踢
    // setTimeout(() => { try { safeChat('/skin set upload classic F:\\Minft111wodeshijie\\.minecraft\\skin.png'); } catch {} }, 3000);
    // registry映射兜底(06-12)：本次连接没收到/没解析成registry包→回放上次存盘的映射
    // （金锭显示成golden_pickaxe=物品表整张退回原版id，就是这种连接）
    if (!bot._registryApplied) {
      try {
        const saved = JSON.parse(fs.readFileSync(REGISTRY_MAPPING_PATH, "utf8"));
        if (saved && (Object.keys(saved.blocks || {}).length || Object.keys(saved.items || {}).length)) {
          log("[registry] 本次连接没解析到registry包 → 回放存盘映射");
          applyRegistryMapping(saved);
        }
      } catch (e) { log(`[registry] 存盘映射回放失败: ${e.message}`); }
    }
    // attack防踢补丁(06-12)：对无效实体出手会被服务器踢(invalid_entity_attacked)。
    // 包一层校验,覆盖所有调用方(含pvp插件):实体还在世界里/不是自己/我没死/距离够得着
    if (!bot._attackPatched) {
      bot._attackPatched = true;
      const _origAttack = bot.attack.bind(bot);
      bot.attack = function (entity, swing) {
        try {
          if (!entity || entity.id === undefined) { log("[combat] skip attack: 无实体"); return; }
          if (!bot.entities[entity.id]) { log(`[combat] skip attack: 实体${entity.id}已不在世界(防invalid_entity_attacked被踢)`); return; }
          if (entity.isValid === false) { log(`[combat] skip attack: 实体${entity.id}已失效`); return; }
          if (bot.entity && entity.id === bot.entity.id) { log("[combat] skip attack: 目标是自己"); return; }
          if (bot.health !== undefined && bot.health <= 0) { log("[combat] skip attack: 我死了"); return; }
          const d = bot.entity.position.distanceTo(entity.position);
          if (d > 6) { log(`[combat] skip attack: 太远d=${d.toFixed(1)}`); return; }
        } catch (e) { /* 校验本身出错就放行,别把正常攻击拦死 */ }
        return _origAttack(entity, swing);
      };
    }
    // 主动威胁雷达(06-13 煊煊点的："挨打了才知道怪,太被动")：每2.5秒扫16格内hostile/unknown_mob,
    // 发现新威胁提前通知。防刷屏:同一只怪60秒一次+全局5秒间隔;战斗中不报;只报警不先动手(免得见birt也拔剑)
    if (!bot._threatRadar) {
      bot._threatRadar = setInterval(() => {
        try {
          if (gen !== botGen) { clearInterval(bot._threatRadar); return; }
          if (!connected || !bot.entity) return;
          if (bot._engaging || combatMode) return;
          const now = Date.now();
          bot._threatSeen = bot._threatSeen || {};
          if (now - (bot._lastThreatNotify || 0) < 5000) return;
          const pos = bot.entity.position;
          let nearest = null, nd = 16;
          for (const id of Object.keys(bot.entities)) {
            const e = bot.entities[id];
            if (!e || !e.position || e === bot.entity) continue;
            const c = classifyEntity(e);
            if (c !== "hostile" && c !== "unknown_mob") continue;
            const d = pos.distanceTo(e.position);
            if (d < nd && now - (bot._threatSeen[id] || 0) > 60000) { nd = d; nearest = { e, d, id }; }
          }
          if (nearest) {
            bot._threatSeen[nearest.id] = now;
            bot._lastThreatNotify = now;
            const nm = entityRealName(nearest.e);
            log(`[radar] 威胁: ${nm} ${nearest.d.toFixed(1)}格`);
            notifyClaude(`[MC] 雷达: ${nm} 在${nearest.d.toFixed(0)}格外${nearest.d < 6 ? "，很近！" : ""}`, { event: "threat" });
          }
        } catch (e) { log(`[radar] ${e.message}`); }
      }, 2500);
    }
    // 挖掘工具兜底(06-12)：pathfinder挖隧道时bestHarvestTool对mod方块返回null→徒手抠。
    // 包一层:原版算不出就按方块名猜(ore/stone→镐 log→斧 dirt→锹)
    if (!bot._toolPatched && bot.pathfinder && typeof bot.pathfinder.bestHarvestTool === "function") {
      bot._toolPatched = true;
      const _origBestTool = bot.pathfinder.bestHarvestTool.bind(bot.pathfinder);
      bot.pathfinder.bestHarvestTool = function (block) {
        let t = null;
        try { t = _origBestTool(block); } catch {}
        return t || pickToolByName(block);
      };
    }
    if (!bot._blockAtPatched) {
      const _origBlockAt = bot.blockAt.bind(bot);
      bot.blockAt = function (point, extra) {
        const bl = _origBlockAt(point, extra);
        if (bl && !Array.isArray(bl.shapes)) {
          const flag = (bl.stateId !== undefined) ? solidTable[bl.stateId] : undefined;
          bl.shapes = (flag === 1) ? [[0, 0, 0, 1, 1, 1]] : [];
        }
        return bl;
      };
      bot._blockAtPatched = true;
    }
    const mcData = require("minecraft-data")(bot.version);
    const _vec3 = require("vec3");
    const makeGetBlock = () => function (pos, dx, dy, dz) {
      const b = pos ? this.bot.blockAt(_vec3(pos.x + dx, pos.y + dy, pos.z + dz), false) : null;
      if (!b) {
        return { replaceable: false, canFall: false, safe: false, physical: false, liquid: false, climbable: false, height: dy, openable: false };
      }
      if (!Array.isArray(b.shapes)) {
        const _sf = (b.stateId !== undefined) ? solidTable[b.stateId] : undefined;
        b.shapes = (_sf === 1) ? [[0, 0, 0, 1, 1, 1]] : [];
      }
      b.climbable = this.climbables.has(b.type);
      b.safe = (b.boundingBox === "empty" || b.climbable || this.carpets.has(b.type)) && !this.blocksToAvoid.has(b.type);
      b.physical = b.boundingBox === "block" && !this.fences.has(b.type);
      b.replaceable = this.replaceables.has(b.type) && !b.physical;
      b.liquid = this.liquids.has(b.type);
      // 岩浆避让(06-20)：mod服可能block type对不上，按名字兜底
      const bName = stateIdCache[b.stateId] || b.name || "";
      if (!b.liquid && /lava/.test(bName)) { b.liquid = true; b.safe = false; }
      if (b.safe && /lava|magma/.test(bName)) { b.safe = false; }
      b.height = pos.y + dy;
      b.canFall = this.gravityBlocks.has(b.type);
      b.openable = this.openable.has(b.type);
      for (const shape of b.shapes) { b.height = Math.max(b.height, pos.y + dy + shape[4]); }
      if (b.stateId !== undefined && !b.liquid) {
        const flag = solidTable[b.stateId];
        if (_gbDbg < 10) { _gbDbg++; log(`[gbdbg] sid=${b.stateId} flag=${flag} bb=${b.boundingBox} type=${b.type}`); }
        if (flag !== undefined) {
          if (flag === 0) {
            b.physical = false;
            if (!this.blocksToAvoid.has(b.type)) b.safe = true;
          } else if (flag === 2) {
            // 半碰撞(06-13)：小石子/矮草/台阶/地毯这类。之前一律当全墙→mod野地全是断头路,follow卡死tp循环。
            // 按名字分流：栅栏/墙/玻璃板类=1.5高跳不过去;其余按半砖处理,能踩上去走过去
            const n2 = (stateIdCache[b.stateId] || b.name || "");
            b.physical = true;
            b.safe = false;
            b.replaceable = false;
            if (/fence|wall|gate|bars|pane|chain/.test(n2)) {
              b.shapes = [[0, 0, 0, 1, 1.5, 1]];
              b.height = pos.y + dy + 1.5;
            } else {
              b.shapes = [[0, 0, 0, 1, 0.5, 1]];
              b.height = pos.y + dy + 0.5;
            }
          } else {
            b.physical = true;
            b.safe = false;
            b.replaceable = false;
          }
        }
      }
      if (b.name && /(^|_)door$/.test(b.name) && !b.name.includes("trapdoor")) {
        b.physical = false; b.safe = true; b.replaceable = false;
      }
      return b;
    };
    const scaf = [];
    try {
      for (const nm of ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone"]) {
        const it = mcData.itemsByName[nm];
        if (it) scaf.push(it.id);
      }
    } catch {}
    const digMovements = new Movements(bot, mcData);
    digMovements.canDig = true;
    digMovements.allow1by1towers = true;
    if (scaf.length) digMovements.scafoldingBlocks = scaf;
    digMovements.getBlock = makeGetBlock();
    const followMovements = new Movements(bot, mcData);
    followMovements.canDig = false;
    followMovements.allow1by1towers = false;
    followMovements.canOpenDoors = false;
    followMovements.allowParkour = true; // 06-13:跨步跳沟,追人少绕路
    followMovements.allowSprinting = true;
    followMovements.getBlock = makeGetBlock();
    // 岩浆避让(06-20)：mod服lava可能ID不在默认blocksToAvoid里，显式加上
    for (const lavaName of ["lava", "flowing_lava"]) {
      const lavaBlock = mcData.blocksByName[lavaName];
      if (lavaBlock) {
        digMovements.blocksToAvoid.add(lavaBlock.id);
        followMovements.blocksToAvoid.add(lavaBlock.id);
        digMovements.liquids.add(lavaBlock.id);
        followMovements.liquids.add(lavaBlock.id);
      }
    }
    bot._digMovements = digMovements;
    bot._followMovements = followMovements;
    const movements = digMovements;
    bot.pathfinder.setMovements(digMovements);
    bot.pathfinder.thinkTimeout = 2000;
    bot.removeAllListeners("path_update");
    bot.on("path_update", (r) => {
      log(`[pathdbg] status=${r.status} pathLen=${r.path ? r.path.length : "?"} cost=${r.cost !== undefined ? Math.round(r.cost) : "?"} time=${r.time}ms visited=${r.visitedNodes} gen=${r.generatedNodes}`);
    });
    safeChat("琛屿上线了！");
    log("Deferred init complete.");
    }, 10000);

    // 低血量/饥饿值自动提醒 + 危险自动逃跑
    let lastHealthWarn = 0;
    let lastFoodWarn = 0;
    let lastAutoFlee = 0;
    setInterval(() => {
      if (!connected || !bot.entity) return;
      const now = Date.now();
      // 危急：血量≤6 自动吃东西+通知（不自动跑，不丢下煊煊）
      if (bot.health <= 6 && now - lastAutoFlee > 5000) {
        lastAutoFlee = now;
        notifyClaude(`[MC] 🚨 血量危急！${Math.round(bot.health)}/20`, { event: "critical_health" });
        // 07-06两条军规(埋墙闷死时1血把唯一金苹果送掉的学费)：
        // ①头卡在实心方块/岩浆里=持续环境伤害停不下来,吃了也白吃——不吃,省下食物
        // ②金苹果/附魔金对【自动】进食永久禁菜,神器留给玩家/主session手动决策(eat工具指定item才吃得到)
        let inWall = false;
        try {
          const headB = bot.blockAt(bot.entity.position.offset(0, 1, 0));
          if (headB) {
            const hn = (stateIdCache[headB.stateId] || headB.name || "").replace("minecraft:", "");
            inWall = !airyN(hn) && !hn.includes("water");
          }
        } catch {}
        if (inWall) {
          log("[auto-eat] 头卡在方块/岩浆里,持续伤害吃了也白吃,不动食物(尤其金苹果)");
        } else {
          const food = bot.inventory.items().find((i) =>
            !i.name.includes("golden") && !i.name.includes("enchanted") &&
            (i.name.includes("cooked") || i.name.includes("bread") || i.name.includes("steak") || i.name.includes("apple"))
          );
          if (food) {
            bot.equip(food, "hand").then(() => bot.consume()).catch(() => {});
            notifyClaude(`[MC] 自动吃了 ${food.name}`, { event: "auto_eat" });
          }
        }
      } else if (bot.health <= 10 && now - lastHealthWarn > 10000) {
        lastHealthWarn = now;
        notifyClaude(`[MC] ⚠️ 血量低！${Math.round(bot.health)}/20`, { event: "low_health" });
      }
      // 自动进食(06-13煊煊点的"饿了就会自己吃")：饿≤8且没在打架→自己吃。原来只有血≤6才auto吃,今晚饿到4格还傻跟着跑
      if (bot.food <= 8 && !bot._engaging && !bot._autoEating) {
        const food = bot.inventory.items().find((i) =>
          i.name.includes("bread") || i.name.includes("cooked") || i.name.includes("steak") ||
          (i.name.includes("apple") && !i.name.includes("golden")) || i.name.includes("baked_potato")
        );
        if (food) {
          bot._autoEating = true;
          log(`[auto-eat] 饿${Math.round(bot.food)}/20 自动吃${food.name}`);
          bot.equip(food, "hand").then(() => bot.consume()).catch(() => {}).then(() => { bot._autoEating = false; });
        }
      }
      if (bot.food <= 6 && now - lastFoodWarn > 10000) {
        lastFoodWarn = now;
        notifyClaude(`[MC] ⚠️ 饥饿值低！${Math.round(bot.food)}/20 快吃东西`, { event: "low_food" });
      }
    }, 5000);

    // 防踢：每5秒发送位置包，避免invalid_player_movement
    setInterval(() => {
      if (connected && bot.entity) {
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.02;
        bot.look(yaw, bot.entity.pitch, false);
      }
    }, 5000);
  });

  // spawn超时兜底：15秒没spawn但连接还在，强制标记connected并尝试tp
  setTimeout(() => {
    if (!spawnFired && bot && !connected) {
      log("spawn timeout! Force-setting connected and attempting tp...");
      connected = true;
      notifyClaude("[MC] spawn超时但连接存活，强制上线！");
    }
  }, 15000);

  // 聊天去重（chat/messagestr/message可能重复触发）
  const recentMsgs = new Set();
  function dedupe(key, ttl = 3000) {
    if (recentMsgs.has(key)) return true;
    recentMsgs.add(key);
    setTimeout(() => recentMsgs.delete(key), ttl);
    return false;
  }

  // === 原始协议层监听（调试用）===
  bot._client.on("playerChat", (data) => {
    log(`[RAW playerChat] senderName=${data.senderName} plainMessage=${data.plainMessage} formattedMessage=${data.formattedMessage ? data.formattedMessage.substring(0, 100) : 'null'} type=${JSON.stringify(data.type)}`);
  });
  bot._client.on("systemChat", (data) => {
    log(`[RAW systemChat] positionId=${data.positionId} formattedMessage=${data.formattedMessage ? data.formattedMessage.substring(0, 100) : 'null'}`);
  });

  // BlockInfo Mod自动学习 — 解析[BI]消息自动更新stateId映射
  function handleBlockInfoMessage(text) {
    // [BI] 准星 minecraft:oak_trapdoor sid:6425 (945,67,-380) [facing=west,...]
    const blockMatch = text.match(/\[BI\] 准星 (\S+) sid:(\d+)/);
    if (blockMatch) {
      const [, blockName, sidStr] = blockMatch;
      const sid = parseInt(sidStr);
      const current = stateIdCache[sid];
      if (current !== blockName) {
        stateIdCache[sid] = blockName;
        const shortName = blockName.replace("minecraft:", "");
        const vanillaData = bot.registry.blocksByName[shortName];
        bot.registry.blocksByStateId[sid] = vanillaData || {
          id: sid, name: blockName, displayName: blockName, hardness: 1, diggable: true, boundingBox: "block",
        };
        saveStateIdCache();
        log(`[BI-learn] stateId ${sid} = ${blockName} (from BlockInfo Mod)`);
      }
      return true;
    }
    // [BI] 手持 minecraft:diamond_sword id:795 数量:1
    const itemMatch = text.match(/\[BI\] 手持 (\S+) id:(\d+)/);
    if (itemMatch) {
      const [, itemName, ridStr] = itemMatch;
      const rid = parseInt(ridStr);
      const current = itemIdCache[rid];
      if (current !== itemName) {
        itemIdCache[rid] = itemName;
        const shortName = itemName.replace("minecraft:", "");
        const vanillaData = bot.registry.itemsByName[shortName];
        if (vanillaData) {
          bot.registry.items[rid] = vanillaData.id === rid ? vanillaData : { ...vanillaData, id: rid }; // 克隆改id
        } else {
          bot.registry.items[rid] = { id: rid, name: itemName, displayName: itemName, stackSize: 64 };
        }
        try { bot.registry.itemsArray = Object.values(bot.registry.items); } catch {}
        saveItemIdCache();
        log(`[BI-learn] itemId ${rid} = ${itemName} (from BlockInfo Mod)`);
      }
      return true;
    }
    return false;
  }

  // 聊天消息（多事件兜底）
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    log(`[chat] <${username}> ${message}`);
    if (message.startsWith("[BI]")) {
      handleBlockInfoMessage(message);
      // 流体消息去重：同类型流体只通知一次（30秒内）
      const fluidMatch = message.match(/\[BI\] 流体 (\S+)/);
      if (fluidMatch) {
        const fluidKey = `fluid:${fluidMatch[1]}`;
        if (dedupe(fluidKey, 30000)) return;
      }
      // 玩家位置消息去重（生物群系不变时不重复发）
      const posMatch = message.match(/\[BI\] 玩家位置.*生物群系:(\S+)/);
      if (posMatch) {
        const biomeKey = `biome:${posMatch[1]}`;
        if (dedupe(biomeKey, 30000)) return;
      }
    }
    if (dedupe(`${username}:${message}`)) return;
    notifyClaude(message, { user: username, user_id: `mc-${username}` });
  });

  bot.on("messagestr", (message, messagePosition, jsonMsg) => {
    const text = message.toString();
    log(`[messagestr RAW] position=${messagePosition} text="${text}" empty=${!text.trim()} hasBotName=${text.includes(bot.username)}`);
    if (!text.trim()) return;
    const match = text.match(/^<(\w+)>\s*(.+)$/);
    if (match) {
      const [, user, msg] = match;
      if (user === bot.username) return;
      if (dedupe(`${user}:${msg}`)) return;
      notifyClaude(msg, { user, user_id: `mc-${user}` });
    } else if (messagePosition !== "game_info") {
      if (dedupe(`sys:${text}`)) return;
      notifyClaude(`[MC] ${text}`, { event: "system" });
    }
  });

  // message事件兜底（1.19+签名聊天可能只触发这个）
  bot.on("message", (jsonMsg, position, sender) => {
    log(`[message RAW] position=${position} sender=${sender} text="${jsonMsg.toString()}"`);
    if (position === "game_info") return;
    const text = jsonMsg.toString();
    if (!text.trim()) return;
    const match = text.match(/^<(\w+)>\s*(.+)$/);
    if (match) {
      const [, user, msg] = match;
      if (user === bot.username) return;
      if (dedupe(`${user}:${msg}`)) return;
      notifyClaude(msg, { user, user_id: `mc-${user}` });
    } else {
      if (dedupe(`sys:${text}`)) return;
      notifyClaude(`[MC] ${text}`, { event: "system" });
    }
  });

  // 记录最后攻击者（用于死亡报告）
  let lastAttacker = null;
  let lastDamageTime = 0;
  // knownMobs已提升到模块级（06-12），跨重连保留

  // combatMode/currentTask/interruptTask/endCombat 已提升到模块级

  function findBestWeapon() {
    const items = bot.inventory.items();
    const dict = loadItemDict();
    const weaponKeywords = ["sword", "axe", "blade", "dagger", "mace", "halberd", "spear", "katana", "scythe", "saber", "rapier", "claymore", "cutlass"];
    const tierOrder = ["netherite", "diamond", "iron", "stone", "gold", "wooden", "wood"];

    let candidates = [];
    for (const item of items) {
      const name = item.name.toLowerCase();
      const dictEntry = dict[item.name] || dict[name];
      // pickaxe含"axe"——06-12拿镐子跟僵尸对线的笑话，工具不算武器
      const isTool = name.includes("pickaxe") || name.includes("shovel") || name.includes("hoe");
      const isWeapon = !isTool && (weaponKeywords.some(k => name.includes(k)) ||
        (dictEntry && typeof dictEntry === "object" && dictEntry.usage && dictEntry.usage.includes("武器")));
      if (isWeapon) {
        let tier = tierOrder.findIndex(t => name.includes(t));
        if (tier === -1) tier = 3; // mod weapons default to iron-tier
        // 剑类一票优先于斧锤类(2026-07-06)：走位系统650ms一刀是按剑冷却调的(剑攻速1.6=625ms充满),
        // 斧攻速1.0要1000ms充满,650ms就挥=充能不满伤害打折——同节奏下剑的有效DPS更高。
        // 之前只按单发伤害排序选中钻石斧(9伤)是负优化,实战铁剑都比它打得快打得疼。
        const slowClass = /sword|katana|rapier|saber|cutlass|blade/.test(name) ? 0 : 1;
        candidates.push({ item, tier, slowClass });
      }
    }
    candidates.sort((a, b) => a.slowClass - b.slowClass || a.tier - b.tier);
    return candidates.length > 0 ? candidates[0].item : null;
  }

  function findBow() {
    return bot.inventory.items().find(i => i.name.includes("bow") && !i.name.includes("rainbow"));
  }

  function hasArrows() {
    return bot.inventory.items().some(i => i.name.includes("arrow"));
  }

  async function autoCombat(attackerId) {
    if (!bot || !connected) return;

    // 血量低于6 → 撤退。方向交给fleeFromThreat算(远离怪)——不再无脑tp向她:
    // 她本人可能正站在Warden脸上,tp过去=tp进怪嘴(2026-07-05连送3次的学费)
    if (bot.health <= 6) {
      log(`[combat] 血量太低(${bot.health})，撤退！`);
      safeChat("救命！！要死了！！");
      await fleeFromThreat(bot.entities[attackerId], `血量太低(${Math.round(bot.health)})`);
      return;
    }

    const entity = bot.entities[attackerId];
    if (!entity || entity.type === "player") return;

    // 打不过名单/血牛boss → 不反击,直接撤(所有自动反击都走autoCombat,这一道闸全覆盖)
    const foeDesc = `${entity.name || ""} ${entity.displayName || ""} ${entityRealName(entity)}`;
    const foeMaxHp = getMaxHealth(entity);
    if (UNBEATABLE_RE.test(foeDesc) || (foeMaxHp && foeMaxHp > 100)) {
      log(`[combat] 惹不起的怪(${foeDesc.trim()}${foeMaxHp ? ` ${foeMaxHp}血` : ""}) → 不反击直接撤`);
      await fleeFromThreat(entity, `${entityRealName(entity)}${foeMaxHp ? `(${foeMaxHp}血)` : ""}打不过`);
      return;
    }

    const dist = bot.entity.position.distanceTo(entity.position);

    // 远距离 + 有弓有箭 → 射箭（持续锁定目标）
    if (dist > 5 && findBow() && hasArrows()) {
      try {
        const bow = findBow();
        await bot.equip(bow, "hand");
        await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
        bot.activateItem();
        // 拉弓期间持续追踪目标
        const trackInterval = setInterval(() => {
          if (entity && entity.position && bot.entity) {
            bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0)).catch(() => {});
          }
        }, 100);
        await new Promise(r => setTimeout(r, 1500));
        clearInterval(trackInterval);
        // 释放前最后一次锁定
        if (entity && entity.position) {
          await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
        }
        bot.deactivateItem();
        log(`[combat] 射箭 → ${entity.name || entity.displayName} dist=${dist.toFixed(1)}`);
      } catch (e) { log(`[combat] bow error: ${e.message}`); }
      return;
    }

    // 近距离 → 锁定贴身连打(06-12抄怪的AI，替代旧的"被咬一口还一刀"单发点射)
    await meleeEngage(attackerId, "反击");
  }

  // 近战锁定循环(06-12)——照着僵尸自己的战斗逻辑写的：
  // 锁定目标→持续盯脸→距离>2.8就冲刺追击→贴脸按攻击冷却(650ms)连续出刀→
  // 目标死/跑/超时收手；5秒掉血≥8或血≤8=打不过，撤到煊煊身边
  async function meleeEngage(targetId, reason) {
    if (bot._engaging) { log(`[engage] 已在战斗中,忽略新目标${targetId}`); return; }
    bot._engaging = true;
    interruptTask();
    try { bot.pathfinder.setGoal(null); } catch {} // 清掉 follow 残留的 GoalFollow(玩家)——否则战斗时 pathfinder 还在把 bot 往玩家身上拽，跟追击抢控制
    const start = Date.now();
    let lastSwing = 0;
    let lastHp = bot.health;
    let recentDrops = [];
    let swings = 0;
    // 走位状态(2026-07-05第四轮)
    let strafeDir = Math.random() < 0.5 ? -1 : 1; // 绕圈方向(-1左/+1右),开局随机,卡墙/危险自动换
    let stuckTicks = 0, lastPosXZ = null, surrounded = false, lastSurroundCheck = 0;
    // 一次性设全六个移动键,避免相位切换残留旧按键(sneak不在内,由潜行锁单管)
    const move = (f, b, l, r, sp, j) => {
      bot.setControlState("forward", !!f); bot.setControlState("back", !!b);
      bot.setControlState("left", !!l); bot.setControlState("right", !!r);
      bot.setControlState("sprint", !!sp); bot.setControlState("jump", !!j);
    };
    try {
      const weapon = findBestWeapon();
      if (weapon) { try { await bot.equip(weapon, "hand"); } catch (e) { log(`[engage] equip error: ${e.message}`); } }
      const targetName = (bot.entities[targetId] && (bot.entities[targetId].name || bot.entities[targetId].displayName)) || targetId;
      log(`[engage] 开打(${reason}): ${targetName} 武器=${weapon ? weapon.name : "空手"}`);
      while (connected && bot.health > 0) {
        const e = bot.entities[targetId];
        if (!e || e.isValid === false) { log(`[engage] 目标消失(死了?跑了?谁杀的不知道) 共出刀${swings}次`); break; } // 06-13措辞改老实——上次写"打死"结果是煊煊杀的,我照着日志抢军功
        const d = bot.entity.position.distanceTo(e.position);
        if (d > 20) { log(`[engage] 目标跑出20格,收手`); break; }
        if (Date.now() - start > 30000) { log(`[engage] 30秒超时收手`); break; }
        // 打不过判定:5秒窗口掉血≥8(mod怪一刀9伤两刀就死,等不到低血线) 或 血量≤8
        if (bot.health < lastHp) { recentDrops.push({ t: Date.now(), dmg: lastHp - bot.health }); }
        lastHp = bot.health;
        recentDrops = recentDrops.filter((r) => Date.now() - r.t < 5000);
        const recentDmg = recentDrops.reduce((s, r) => s + r.dmg, 0);
        if (recentDmg >= 8 || bot.health <= 8) {
          log(`[engage] 打不过(5秒掉${recentDmg}血/剩${bot.health}) → 撤`);
          safeChat("打不过！跑了！");
          // 撤退方向/落点/徒步冲刺兜底统一走fleeFromThreat(远离怪,她在怪边上时绝不tp向她)
          await fleeFromThreat(bot.entities[targetId], `伤害太高(5秒掉${recentDmg}血/剩${Math.round(bot.health)})`);
          break;
        }
        // 持续锁脸
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.6) * 0.85, 0), true); } catch {}
        // ===== 走位战斗(2026-07-05第四轮·"走位风骚无敌,力求无伤") =====
        // 原理:玩家近战reach≈3格 > 多数近战怪reach≈2格。节奏循环:
        //   卡2.9格出刀(前冲刀,冲刺击退更远=白嫖窗口)→back+侧移拉到3.3+→绕圈等650ms刀冷却→刀好了斜切进去。
        // 侧移固定绕一边(怪转身有延迟,直线扑击老落空),卡墙3tick/方向危险自动换边。
        // 每步移动前查目标方向1.5格:岩浆/火/仙人掌/浆果丛/粉雪/悬崖(脚下3格空)→换候选方向,四面楚歌就原地出刀不走位。
        // 被围(≥3只在4格内)不绕圈,直线拉扯。sneak锁定不sprint不跳劈(潜行姿态优先)。追击tp落点过findSafeLanding。
        const now = Date.now();
        const sinceSwing = now - lastSwing;
        const cdReady = sinceSwing >= 650; // 1.20.1剑攻速≈0.625s,按650ms节奏
        const canSprint = !bot._sneakLocked;
        if (now - lastSurroundCheck > 500) { // 被围检测(500ms一次,别每tick扫全实体表)
          lastSurroundCheck = now;
          let cnt = 0;
          try {
            for (const oe of Object.values(bot.entities)) {
              if (!oe || oe === bot.entity || !oe.position) continue;
              if (bot.entity.position.distanceTo(oe.position) > 4) continue;
              const c = classifyEntity(oe);
              if (c === "hostile" || c === "unknown_mob") cnt++;
            }
          } catch {}
          surrounded = cnt >= 3;
        }
        if (d > 5) {
          // 追击:刀好了才tp(刚出完刀被击退拉远的,等它自己贴回来,别tp过去白挨打)。落点过安全检查
          if (cdReady && now - (bot._lastChaseTp || 0) >= 1200) { // 1.2s冷却防tp排队拽飞
            try {
              const to = e.position, from = bot.entity.position;
              const dir = from.minus(to);
              const h = Math.hypot(dir.x, dir.z) || 1;
              const land = findSafeLanding(Math.floor(to.x + (dir.x / h) * 2.5), Math.floor(to.y), Math.floor(to.z + (dir.z / h) * 2.5));
              if (land) {
                bot._lastChaseTp = now;
                safeChat(`/tp ${bot.username} ${land.x} ${land.y} ${land.z}`);
                log(`[engage] 追击tp→怪旁(${land.x.toFixed(0)},${land.y},${land.z.toFixed(0)}) d=${d.toFixed(1)}`);
              } else {
                log(`[engage] 追击tp落点不安全(岩浆/悬崖/没加载),改走路追 d=${d.toFixed(1)}`);
              }
            } catch (err) { log(`[engage] chase tp err: ${err.message}`); }
          }
          move(true, false, false, false, canSprint, false); // tp冷却/没落点/刀没好:走着追
          stuckTicks = 0; lastPosXZ = null;
        } else {
          // --- 方向基向量:每tick都lookAt了怪,所以按键系(前后左右)可精确换算成世界系做危险检查 ---
          const twd = e.position.minus(bot.entity.position);
          const th = Math.hypot(twd.x, twd.z) || 1;
          const twx = twd.x / th, twz = twd.z / th;   // 朝怪
          const rvx = -twz, rvz = twx;                 // 面向怪时的"右"(D键)
          const mk = (f, b, l, r, flip) => {           // 按键组合→世界方向(归一化),flip=这是换绕向的备选
            let wx = 0, wz = 0;
            if (f) { wx += twx; wz += twz; }
            if (b) { wx -= twx; wz -= twz; }
            if (r) { wx += rvx; wz += rvz; }
            if (l) { wx -= rvx; wz -= rvz; }
            const hh = Math.hypot(wx, wz) || 1;
            return { f: !!f, b: !!b, l: !!l, r: !!r, wx: wx / hh, wz: wz / hh, flip: !!flip };
          };
          const pick = (cands) => { for (const c of cands) { if (!footworkDanger(c.wx, c.wz)) return c; } return null; };
          // 卡墙检测:该动没动(位移<0.02)连续3tick→换绕向+跳一下(进刀相位的撞墙由blocked跳管)
          let unstickJump = false;
          const px = bot.entity.position.x, pz = bot.entity.position.z;
          if (!cdReady && lastPosXZ) {
            const movedDist = Math.hypot(px - lastPosXZ.x, pz - lastPosXZ.z);
            if (movedDist < 0.02) {
              if (++stuckTicks >= 3) { strafeDir = -strafeDir; stuckTicks = 0; unstickJump = true; log(`[engage] 走位卡墙,换绕向`); }
            } else stuckTicks = 0;
          }
          lastPosXZ = { x: px, z: pz };
          const sL = strafeDir < 0, sR = strafeDir > 0;
          let mv = null;
          if (!cdReady && sinceSwing < 450) {
            // 相位①刚出完刀(0~450ms):撤出怪的reach。被围走直线,不被围back+侧移
            mv = surrounded
              ? pick([mk(0, 1, 0, 0), mk(0, 1, sL, sR), mk(0, 1, sR, sL, true)])
              : pick([mk(0, 1, sL, sR), mk(0, 1, sR, sL, true), mk(0, 1, 0, 0), mk(0, 0, sL, sR), mk(0, 0, sR, sL, true)]);
          } else if (!cdReady) {
            // 相位②等刀冷却(450~650ms):卡3.3~4.2环绕带——太近继续退,太远慢慢跟,不远不近纯绕圈
            if (surrounded) mv = pick([mk(0, 1, 0, 0), mk(0, 1, sL, sR), mk(0, 1, sR, sL, true)]);
            else if (d < 3.3) mv = pick([mk(0, 1, sL, sR), mk(0, 1, sR, sL, true), mk(0, 1, 0, 0), mk(0, 0, sL, sR)]);
            else if (d > 4.2) mv = pick([mk(1, 0, sL, sR), mk(1, 0, sR, sL, true), mk(1, 0, 0, 0)]);
            else mv = pick([mk(0, 0, sL, sR), mk(0, 0, sR, sL, true), mk(0, 1, sL, sR), mk(0, 1, 0, 0)]);
          } else {
            // 相位③刀好了:斜切进刀(带侧移分量,直线扑击不好蒙)
            mv = surrounded
              ? pick([mk(1, 0, 0, 0), mk(1, 0, sL, sR)])
              : pick([mk(1, 0, sL, sR), mk(1, 0, sR, sL, true), mk(1, 0, 0, 0)]);
          }
          if (mv && mv.flip) strafeDir = -strafeDir; // 选中的是换绕向备选→固化新绕向
          if (mv) {
            let j = unstickJump;
            if (cdReady) {
              // 撞墙跳(原有逻辑)+跳劈:单挑且不潜行,2.9~3.6格进刀路上起跳,落下那刀1.5x暴击(10Hz节拍蒙上算赚)
              let blocked = false;
              try {
                const front = bot.blockAt(bot.entity.position.offset(Math.round(twx), 0, Math.round(twz)));
                const frontName = front ? (stateIdCache[front.stateId] || front.name || "") : "";
                blocked = front && frontName !== "air" && frontName !== "cave_air" && !frontName.includes("water");
              } catch {}
              const critJump = !surrounded && canSprint && d > 2.9 && d <= 3.6;
              j = j || blocked || critJump || e.position.y > bot.entity.position.y + 0.9;
            }
            move(mv.f, mv.b, mv.l, mv.r, cdReady && mv.f && canSprint, j);
          } else {
            move(false, false, false, false, false, false); // 四面楚歌(所有方向都危险):原地出刀不走位
          }
          if (cdReady && d <= 2.9) { bot.attack(e); lastSwing = now; swings++; }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      log(`[engage] error: ${err.message}`);
    } finally {
      try { bot.clearControlStates(); } catch {}
      try { bot.pathfinder.setGoal(null); } catch {} // 收手清目标(追击已改tp,不再用_engageChasing);follow还开着的话下一轮会自己重挂
      bot._engaging = false;
      endCombat();
    }
  }
  bot._meleeEngage = meleeEngage; // 给attack工具用

  // ===== 战斗方块安全检查(2026-07-05第四轮·走位/追击tp/fleeFromThreat三处共用同一套) =====
  const combatV3 = require("vec3");
  function blockNameAt(x, y, z) {
    const b = bot.blockAt(combatV3(x, y, z));
    if (!b) return null; // 区块没加载
    return (stateIdCache[b.stateId] || b.name || "").replace("minecraft:", "");
  }
  function airyN(n) { return n === "air" || n === "cave_air" || n === "void_air"; }
  // 找(tx,·,tz)柱子上的安全落点:两格空气+脚下实心且非危险块非水,baseY+3→-4从高往低扫。没有→null。
  // 所有战斗tp(追击tp/撤退tp)的落点统一过这个函数,不tp进岩浆/悬崖/方块里。
  function findSafeLanding(tx, baseY, tz) {
    for (let dy = 3; dy >= -4; dy--) {
      const y = baseY + dy;
      const feet = blockNameAt(tx, y, tz), head = blockNameAt(tx, y + 1, tz), ground = blockNameAt(tx, y - 1, tz);
      if (feet === null || head === null || ground === null) continue; // 没加载,换一格
      if (!airyN(feet) || !airyN(head)) continue;
      if (airyN(ground) || ground.includes("water") || DANGER_BLOCK_RE.test(ground)) continue;
      return { x: tx + 0.5, y, z: tz + 0.5 };
    }
    return null;
  }
  bot._findSafeLanding = findSafeLanding; // 挖矿链的tp兜底也走同一套落点安全检查(工具switch在main作用域,借bot桥接)
  // 走位方向危险检查:沿(wx,wz)走1.5格的落点,脚位/头位/地面是危险块,或悬崖(脚下连3格空=会摔)→true。
  // tiny视距(2区块=32格)下走位半径1~4格必在加载范围;真没加载(null)按安全放行,别把走位吓瘫。
  function footworkDanger(wx, wz) {
    try {
      const p = bot.entity.position;
      const sx = Math.floor(p.x + wx * 1.5), sy = Math.floor(p.y), sz = Math.floor(p.z + wz * 1.5);
      const feet = blockNameAt(sx, sy, sz), head = blockNameAt(sx, sy + 1, sz), g1 = blockNameAt(sx, sy - 1, sz);
      if (feet && DANGER_BLOCK_RE.test(feet)) return true;
      if (head && DANGER_BLOCK_RE.test(head)) return true;
      if (g1 && DANGER_BLOCK_RE.test(g1)) return true;
      if (feet && airyN(feet) && g1 && airyN(g1)) {
        const g2 = blockNameAt(sx, sy - 2, sz), g3 = blockNameAt(sx, sy - 3, sz);
        if (g2 && airyN(g2) && g3 && airyN(g3)) return true; // 落脚点下面≥3格全空
      }
      return false;
    } catch { return false; }
  }

  // ===== 撤退统一出口(2026-07-05 Warden实战学费) =====
  // 旧flee两处都是无脑"/tp 到她身边"——她本人正站在Warden脸上送死时,tp过去=tp进怪嘴,至少连送3次。
  // 新规则：
  //  ①有怪且她离怪>10格 → 她在安全处才配当靠山,tp向她
  //  ②有怪其他情况 → 取bot→怪反方向15/12/8格试落点(要求脚下实心+两格空气,y±4内扫,不落水/岩浆上),tp过去
  //  ③找不到落点/没锁到怪实体 → 不tp,纯徒步跑(没怪时朝视线反方向——挨打时基本正面对怪)
  //  ④凡是撤退都跟一段徒步冲刺(tp在服务器排队延迟生效,期间站桩=挨打,僵尸5秒13血的教训)
  async function fleeFromThreat(threat, why) {
    if (bot._fleeing) { log(`[flee] 已在撤退中,忽略(${why})`); return; }
    bot._fleeing = true;
    try {
      interruptTask();
      try { bot.pathfinder.setGoal(null); } catch {}
      const hasThreat = !!(threat && threat.position && threat.isValid !== false);
      const anchorName = "chenxuan2001";
      const anchorEnt = bot.players[anchorName] && bot.players[anchorName].entity;
      let how = "";
      if (hasThreat && anchorEnt && anchorEnt.position && anchorEnt.position.distanceTo(threat.position) > 10) {
        how = "tp向她(她离怪>10格,在安全位置)";
        safeChat(`/tp ${MC_USERNAME} ${anchorName}`);
      } else if (hasThreat) {
        const me = bot.entity.position;
        const away = me.minus(threat.position);
        const h = Math.hypot(away.x, away.z) || 1;
        let dest = null;
        for (const dd of [15, 12, 8]) { // 由远到近试三档,落点统一走findSafeLanding(不落岩浆/水/危险块/悬空)
          dest = findSafeLanding(Math.floor(me.x + (away.x / h) * dd), Math.floor(me.y), Math.floor(me.z + (away.z / h) * dd));
          if (dest) break;
        }
        if (dest) {
          how = `tp到怪反方向(${dest.x.toFixed(0)},${dest.y},${dest.z.toFixed(0)})`;
          safeChat(`/tp ${MC_USERNAME} ${dest.x} ${dest.y} ${dest.z}`);
        } else {
          how = "反方向没找到安全落点(区块没加载/地形烂),纯徒步跑";
        }
      } else {
        how = "没锁到怪实体,朝视线反方向跑";
      }
      // 徒步冲刺兜底：有怪→背对怪跑,直到离怪>12/怪没了/3秒;没怪→按开跑时的方向跑2秒(方向定死,别每tick跟着yaw转圈)
      let fixedDir = null;
      if (!hasThreat) {
        const yaw = bot.entity.yaw; // 视线方向=(-sin,-cos),反方向=(+sin,+cos)
        fixedDir = { x: Math.sin(yaw), z: Math.cos(yaw) };
      }
      const fleeStart = Date.now();
      const maxMs = hasThreat ? 3000 : 2000;
      while (connected && bot.health > 0 && Date.now() - fleeStart < maxMs) {
        let dirX, dirZ;
        if (hasThreat) {
          if (!threat.position || threat.isValid === false) break; // 怪没了
          if (bot.entity.position.distanceTo(threat.position) > 12) break; // tp生效/已拉开
          const away2 = bot.entity.position.minus(threat.position);
          const h2 = Math.hypot(away2.x, away2.z) || 1;
          dirX = away2.x / h2; dirZ = away2.z / h2;
        } else {
          dirX = fixedDir.x; dirZ = fixedDir.z;
        }
        try { await bot.lookAt(bot.entity.position.offset(dirX * 4, 1.6, dirZ * 4), true); } catch {}
        bot.setControlState("forward", true);
        bot.setControlState("sprint", true);
        bot.setControlState("jump", true);
        await new Promise((r) => setTimeout(r, 100));
      }
      try { bot.clearControlStates(); } catch {}
      log(`[flee] ${why} → ${how}`);
      notifyClaude(`[MC] 撤退(${why}): ${how}`, { event: "flee" });
    } catch (e) {
      log(`[flee] error: ${e.message}`);
    } finally {
      bot._fleeing = false;
    }
  }

  // 拦截击退velocity包：记录被击退前的位置，击退后立刻发position确认回原位
  let preKnockbackPos = null;
  bot._client.on("entity_velocity", (packet) => {
    if (bot.entity && packet.entityId === bot.entity.id) {
      preKnockbackPos = bot.entity.position.clone();
      process.nextTick(() => {
        if (bot && bot.entity && preKnockbackPos) {
          bot.entity.velocity.x = 0;
          bot.entity.velocity.y = 0;
          bot.entity.velocity.z = 0;
          bot.entity.position = preKnockbackPos;
          bot._client.write('position', {
            x: preKnockbackPos.x,
            y: preKnockbackPos.y,
            z: preKnockbackPos.z,
            onGround: bot.entity.onGround,
          });
        }
      });
    }
  });

  // 被攻击 — 用damage_event协议包精确识别攻击者
  let lastDamageSource = null;
  bot._client.on("damage_event", (packet) => {
    try {
      log(`[damage_event] entityId=${packet.entityId} botId=${bot.entity?.id} sourceTypeId=${packet.sourceTypeId} sourceCauseId=${packet.sourceCauseId} sourceDirectId=${packet.sourceDirectId}`);
      if (packet.entityId === bot.entity?.id) {
        // mod服sourceDirectId常为0，fallback到sourceCauseId
        const effectiveAttackerId = (packet.sourceDirectId && packet.sourceDirectId > 0)
          ? packet.sourceDirectId
          : (packet.sourceCauseId && packet.sourceCauseId > 0 ? packet.sourceCauseId : 0);
        if (effectiveAttackerId > 0) {
          const attacker = bot.entities[effectiveAttackerId];
          if (attacker && attacker.type !== "player") {
            lastDamageSource = { sourceTypeId: packet.sourceTypeId, causeId: packet.sourceCauseId, directId: effectiveAttackerId, time: Date.now() };
            const name = attacker.username || attacker.name || attacker.displayName || "未知";
            log(`[damage_event] 识别攻击者: ${name} (id=${effectiveAttackerId}, type=${attacker.type})`);
            notifyClaude(`[MC] 被${name}打了！正在反击！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
            interruptTask();
            autoCombat(effectiveAttackerId).then(() => endCombat());
          } else if (attacker && attacker.type === "player") {
            lastDamageSource = { sourceTypeId: packet.sourceTypeId, causeId: packet.sourceCauseId, directId: effectiveAttackerId, time: Date.now() };
            const name = attacker.username || attacker.displayName || "玩家";
            log(`[damage_event] 被玩家攻击: ${name} (id=${effectiveAttackerId})`);
            lastAttacker = name;
            lastDamageTime = Date.now();
            notifyClaude(`[MC] 被玩家${name}打了！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
          } else {
            // attackerId有但entities里找不到→不设lastDamageSource，让health handler fallback
            // 07-06："看不见的怪"至少变"叫不上名的怪"——把raw id报出来(mod怪spawn包可能被deserializer吞了,
            // 实体表里就是没有它)。5秒去重防连击刷屏。
            log(`[damage_event] attackerId=${effectiveAttackerId} 但entities里找不到 → 报raw id+交给health fallback`);
            if (Date.now() - (bot._lastUnseenNotify || 0) > 5000) {
              bot._lastUnseenNotify = Date.now();
              notifyClaude(`[MC] 被看不见的实体打了(entity id=${effectiveAttackerId}, sourceType=${packet.sourceTypeId}, 实体表里没有它——疑似spawn包被吞的mod怪) 血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
            }
          }
        }
      }
    } catch (e) {
      log(`[damage_event] parse error: ${e.message}`);
    }
  });

  bot.on("hurt", () => {
    try {
      log(`[hurt] fired! health=${bot.health} oxygen=${bot.oxygenLevel}`);
      let damageSource = "";
      let attackerName = "";

      const hasDmgPacket = lastDamageSource && (Date.now() - lastDamageSource.time < 500);
      const directEntityId = hasDmgPacket ? lastDamageSource.directId : 0;

      if (directEntityId && directEntityId > 0) {
        const entity = bot.entities[directEntityId];
        if (entity) {
          attackerName = entity.username || entity.name || entity.displayName || "未知生物";
          damageSource = "attack";
          if (entity.type !== "player" && entity.name) {
            const mobKey = entity.name;
            if (!knownMobs[mobKey]) {
              knownMobs[mobKey] = { type: entity.type, name: entity.name, displayName: entity.displayName || "", entityType: entity.entityType, firstSeen: new Date().toISOString() };
              log(`[mob-learn] 新怪物: ${mobKey} type=${entity.type} entityType=${entity.entityType} display=${entity.displayName}`);
              notifyClaude(`[MC] 遇到新怪物: ${entity.displayName || entity.name} (${entity.name}, type=${entity.type})`, { event: "mob_learn" });
            }
          }
        }
      }

      if (!damageSource) {
        const inWater = bot.oxygenLevel !== undefined && bot.oxygenLevel <= 0;
        const pos = bot.entity?.position;
        const eyePos = pos ? pos.offset(0, 1.62, 0) : null;
        const blockAtHead = eyePos ? bot.blockAt(eyePos) : null;
        const suffocating = blockAtHead && blockAtHead.boundingBox === "block";
        const onFire = bot.entity?.metadata?.[0] & 1;

        if (suffocating) {
          damageSource = "窒息";
        } else if (inWater) {
          damageSource = "溺水";
        } else if (onFire) {
          damageSource = "着火";
        }
      }

      lastDamageSource = null;

      if (damageSource === "attack") {
        lastAttacker = attackerName;
        lastDamageTime = Date.now();
        interruptTask();
        autoCombat(directEntityId).then(() => endCombat());
        notifyClaude(`[MC] 被${attackerName}打了！正在反击！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
      } else if (damageSource) {
        notifyClaude(`[MC] ${damageSource}中！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
      } else {
        // fallback：不知道谁打的→找最近的怪反击（06-12改用classifyEntity，mod怪也认）
        let nearestMob = null, nearestDist = 10;
        for (const e of Object.values(bot.entities)) {
          if (!e || !e.position || e === bot.entity) continue;
          const d = bot.entity.position.distanceTo(e.position);
          if (d < nearestDist) {
            const c = classifyEntity(e);
            if (c === "hostile" || c === "unknown_mob" || c === "other") {
              nearestMob = e; nearestDist = d;
            }
          }
        }
        if (nearestMob) {
          const name = nearestMob.username || nearestMob.name || nearestMob.displayName || "未知";
          log(`[hurt] fallback: 找到最近怪物 ${name} dist=${nearestDist.toFixed(1)} → 反击`);
          interruptTask();
          autoCombat(nearestMob.id).then(() => endCombat());
          notifyClaude(`[MC] 被${name}打了！正在反击！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
        } else {
          notifyClaude(`[MC] 受到伤害！血量: ${Math.round(bot.health || 0)}/20`, { event: "hurt" });
        }
      }
    } catch (e) {
      log(`[hurt] handler error: ${e.message}`);
      notifyClaude(`[MC] 受到伤害！血量: ${Math.round(bot.health || 0)}/20`, { event: "hurt" });
    }
  });

  // health事件备份（hurt有时不触发）— 作为主要伤害检测fallback
  let lastHealth = 20;
  let lastHealthCombatTrigger = 0;
  let firstHealthAt = 0; // 幽灵伤害修复(06-12)：spawn时血量从上次残血同步(20→16)被当成"挨打了"→每次上线冤枉煊煊
  bot.on("health", () => {
    if (!firstHealthAt) {
      firstHealthAt = Date.now();
      log(`[health] 初始血量同步: ${bot.health}/20 (不算挨打)`);
      lastHealth = bot.health;
      return;
    }
    if (Date.now() - firstHealthAt < 5000) { lastHealth = bot.health; return; } // spawn后5秒内的血量跳变也不算
    const dropped = bot.health < lastHealth;
    const dropAmount = lastHealth - bot.health;
    if (dropped) {
      log(`[health] dropped: ${lastHealth} -> ${bot.health} (delta=${dropAmount.toFixed(1)})`);
      const now = Date.now();
      // 如果damage_event已经在500ms内处理过攻击者，不重复触发
      const recentDamage = lastDamageSource && (now - lastDamageSource.time < 500);
      const recentCombatTrigger = (now - lastHealthCombatTrigger) < 2000;

      if (!recentDamage && !recentCombatTrigger && !combatMode) {
        // hurt和damage_event都没处理 → 用附近实体作为fallback
        // 优先查玩家（只通知不反击），再查怪物（通知+反击）
        const pos = bot.entity?.position;
        if (pos) {
          let nearestPlayer = null, playerDist = 5;
          let nearestHostile = null, hostileDist = 10;
          for (const id of Object.keys(bot.entities)) {
            const e = bot.entities[id];
            if (!e || !e.position || e === bot.entity) continue;
            const dist = pos.distanceTo(e.position);
            if (e.type === "player" && dist < playerDist) {
              nearestPlayer = e; playerDist = dist;
            }
            const cls = classifyEntity(e);
            if ((cls === "hostile" || cls === "unknown_mob" || cls === "other") && dist < hostileDist) {
              nearestHostile = e; hostileDist = dist;
            }
          }
          // 06-12改：怪优先归因。玩家在附近≠玩家打的——mod怪雷达可能扫不到，曾因此冤枉煊煊
          if (nearestHostile) {
            // 移到下面统一处理
          } else if (nearestPlayer && playerDist <= 4) {
            const name = nearestPlayer.username || nearestPlayer.displayName || "玩家";
            log(`[health-fallback] 掉血+附近只有玩家: ${name} dist=${playerDist.toFixed(1)} 不咬定是ta`);
            notifyClaude(`[MC] 受到伤害！雷达只扫到玩家${name}在附近(不一定是ta打的,可能是看不见的mod怪) 血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
          }
          if (nearestHostile) {
            const name = nearestHostile.username || nearestHostile.name || nearestHostile.displayName || "未知怪物";
            log(`[health-fallback] 掉血+附近hostile: ${name} dist=${hostileDist.toFixed(1)} → 反击`);
            lastAttacker = name;
            lastDamageTime = now;
            lastHealthCombatTrigger = now;
            interruptTask();
            autoCombat(nearestHostile.id).then(() => endCombat());
            notifyClaude(`[MC] 被${name}打了！正在反击！血量: ${Math.round(bot.health)}/20`, { event: "hurt" });
          } else if (dropAmount >= 1 && !(nearestPlayer && playerDist <= 4)) {
            // 07-06：谁都没扫到时dump最近3个非玩家实体的raw信息(16格)——"看不见"至少留个线索
            let rawDump = "";
            try {
              const rawCands = Object.values(bot.entities)
                .filter((re) => re && re.position && re !== bot.entity && re.type !== "player" && pos.distanceTo(re.position) <= 16)
                .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position))
                .slice(0, 3)
                .map((re) => `${entityRealName(re)}(type=${re.type || "?"},et=${re.entityType ?? "?"},${pos.distanceTo(re.position).toFixed(0)}格)`);
              if (rawCands.length) rawDump = ` 16格内实体:${rawCands.join("/")}`;
            } catch {}
            notifyClaude(`[MC] 受到伤害！血量: ${Math.round(bot.health)}/20${rawDump}`, { event: "hurt" });
          }
        }
      }
    }
    lastHealth = bot.health;
  });

  // update_health协议包fallback — 确保mineflayer不漏health事件
  bot._client.on("update_health", (packet) => {
    try {
      const newHealth = packet.health;
      if (newHealth !== undefined && newHealth < lastHealth) {
        log(`[update_health_packet] ${lastHealth} -> ${newHealth}`);
        // mineflayer应该会自己emit health事件，但如果没有，手动更新
        // 这里只做日志，实际触发靠bot.on("health")
      }
    } catch (e) { /* ignore */ }
  });

  // 被扛起来/骑乘
  bot.on("mount", () => {
    try {
      const vehicle = bot.vehicle;
      const carrier = vehicle ? (vehicle.username || vehicle.name || "某个东西") : "未知";
      log(`[mount] mounted by ${carrier}`);
      notifyClaude(`[MC] 被${carrier}扛起来了！`, { event: "mount" });
    } catch (e) {
      log(`[mount] error: ${e.message}`);
      notifyClaude(`[MC] 被扛起来了！`, { event: "mount" });
    }
  });

  bot.on("dismount", (vehicle) => {
    try {
      const carrier = vehicle ? (vehicle.username || vehicle.name || "某个东西") : "未知";
      log(`[dismount] dismounted from ${carrier}`);
      notifyClaude(`[MC] 被${carrier}放下来了`, { event: "dismount" });
    } catch (e) {
      log(`[dismount] error: ${e.message}`);
      notifyClaude(`[MC] 被放下来了`, { event: "dismount" });
    }
  });

  // set_passengers协议包监听 — mod服mount/dismount事件都经常不触发，包才是真相(06-12双向化)
  // 扛起:passengers里出现bot id → 记carried状态(顺便补bot.vehicle)
  // 放下:passengers里不再有bot id → 清carried状态
  bot._client.on("set_passengers", (packet) => {
    try {
      if (gen !== botGen) return;
      const botId = bot.entity ? bot.entity.id : null;
      if (botId === null) return;
      if (packet.passengers && packet.passengers.includes(botId)) {
        if (bot._carriedVehicleId !== packet.entityId) {
          bot._carriedVehicleId = packet.entityId;
          bot._carriedSince = Date.now();
          const v = bot.entities[packet.entityId];
          const carrier = v ? (v.username || v.name || "某个东西") : "某个东西";
          log(`[set_passengers] 被${carrier}扛起来了(包检测)`);
          if (!bot.vehicle && v) bot.vehicle = v; // mount事件没触发时补上
        }
        return;
      }
      // 这个包的passengers里没有bot → 如果它正是我们记录的vehicle,说明被放下了
      const curVid = bot._carriedVehicleId != null ? bot._carriedVehicleId : (bot.vehicle ? bot.vehicle.id : null);
      if (curVid !== null && packet.entityId === curVid) {
        const oldVehicle = bot.vehicle || bot.entities[curVid];
        const carrier = oldVehicle ? (oldVehicle.username || oldVehicle.name || "某个东西") : "未知";
        log(`[set_passengers] bot不在vehicle(${carrier})的passengers里了 → 被放下`);
        try { bot.dismount(); } catch {}
        bot.vehicle = null;
        bot._carriedVehicleId = null;
        bot._carriedSince = null;
        bot.emit("dismount", oldVehicle);
      }
    } catch (e) {
      log(`[set_passengers] error: ${e.message}`);
    }
  });

  // 死亡 — 记录坐标，自动重生
  let deathPos = null;
  let recentDeaths = []; // 死亡循环保护(06-12)：记录最近死亡时间戳
  bot.on("death", () => {
    if (gen !== botGen) return;
    // 死了立刻停手(06-12)：pvp插件死后还在对失效实体挥拳→invalid_entity_attacked被踢
    try { bot.pvp.stop(); } catch {}
    try { endCombat(); } catch {}
    try { bot.pathfinder.setGoal(null); } catch {}
    try { bot.clearControlStates(); } catch {}
    if (bot.entity) {
      deathPos = {
        x: Math.round(bot.entity.position.x),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z),
      };
    }
    let deathCause = "未知原因";
    if (lastAttacker && Date.now() - lastDamageTime < 10000) {
      deathCause = `被${lastAttacker}杀了`;
    } else if (bot.entity && bot.entity.position.y < -60) {
      deathCause = "掉进虚空";
    } else if (bot.oxygenLevel !== undefined && bot.oxygenLevel <= 0) {
      deathCause = "淹死了";
    }
    notifyClaude(`[MC] 我死了！${deathCause} 死亡坐标: ${deathPos ? `${deathPos.x},${deathPos.y},${deathPos.z}` : "未知"} 自动重生中...`, { event: "death" });
    setTimeout(() => {
      try { bot.respawn(); } catch (e) { log("respawn error: " + e.message); }
    }, 1000);
  });

  // 重生 — 自动tp回死亡点捡墓碑
  bot.on("spawn", () => {
    if (gen !== botGen) return;
    connected = true;
    const pos = bot.entity.position;
    notifyClaude("[MC] 重生了！位置: " +
      Math.round(pos.x) + "," + Math.round(pos.y) + "," + Math.round(pos.z), { event: "respawn" });

    if (deathPos) {
      const dp = deathPos;
      deathPos = null;
      // 死亡循环保护(06-12)：90秒内第3次死→怪在死亡点蹲守，别再送了
      const nowTs = Date.now();
      recentDeaths = recentDeaths.filter((t) => nowTs - t < 90000);
      recentDeaths.push(nowTs);
      if (recentDeaths.length >= 3) {
        notifyClaude(`[MC] ⚠️ 90秒内死了${recentDeaths.length}次，怪八成蹲在死亡点，不自动回去送了。墓碑在 ${dp.x},${dp.y},${dp.z} 附近，清完怪手动捡`, { event: "death_loop_guard" });
        return;
      }
      // 敌情预扫(07-06)：tp回死亡点【之前】先用entities扫死亡点15格内有没有敌对怪——
      // 旧的死亡循环保护要90秒内死满3次才拦，Warden守尸场景前2条命纯白送(还搭每条命的面包)。
      // 局限：重生点离死亡点太远时那边实体没加载、扫不到(此时行为同旧版)，所以落地后还有一道复查。
      let guardMob = null;
      try {
        for (const gid of Object.keys(bot.entities)) {
          const ge = bot.entities[gid];
          if (!ge || !ge.position || ge === bot.entity) continue;
          const gc = classifyEntity(ge);
          if (gc !== "hostile" && gc !== "unknown_mob") continue;
          const gd = Math.hypot(ge.position.x - dp.x, ge.position.y - dp.y, ge.position.z - dp.z);
          if (gd <= 15) { guardMob = { name: entityRealName(ge), dist: gd }; break; }
        }
      } catch {}
      if (guardMob) {
        notifyClaude(`[MC] ⚠️ 死亡点15格内有 ${guardMob.name}(${guardMob.dist.toFixed(0)}格) 守着，不自动回去送。墓碑在 ${dp.x},${dp.y},${dp.z}，清完怪再手动回`, { event: "death_guard" });
        return;
      }
      log(`death pos recorded: ${dp.x},${dp.y},${dp.z}, tp back in 3s...`);
      setTimeout(() => {
        // 落点安全化(07-06)：旧的dp.y+2可能正好在墙里(开箱tp同款闷死bug)。findSafeLanding扫不出
        // (死亡点区块还没加载时blockAt全null)就退回旧的y+2——行为不劣化,能安全则安全
        const land = findSafeLanding(dp.x, dp.y + 1, dp.z) || { x: dp.x + 0.5, y: dp.y + 2, z: dp.z + 0.5 };
        safeChat(`/tp ${MC_USERNAME} ${land.x} ${land.y} ${land.z}`);
        notifyClaude(`[MC] 已tp回死亡点 ${dp.x},${dp.y},${dp.z} 找墓碑中...`, { event: "return_to_death" });
        // 延迟后尝试右键附近的墓碑方块
        setTimeout(async () => {
          if (!bot || !bot.entity) return;
          // 落地敌情复查(07-06)：预扫因实体没加载漏掉的守尸怪,tp到了立刻再查一次,有怪先撤墓碑后捡
          try {
            const camper = Object.values(bot.entities).find((ce) => {
              if (!ce || !ce.position || ce === bot.entity) return false;
              const cc = classifyEntity(ce);
              return (cc === "hostile" || cc === "unknown_mob") && bot.entity.position.distanceTo(ce.position) <= 12;
            });
            if (camper) {
              notifyClaude(`[MC] ⚠️ 死亡点有 ${entityRealName(camper)} 蹲守！先撤，清完怪再手动捡墓碑(${dp.x},${dp.y},${dp.z})`, { event: "death_guard" });
              await fleeFromThreat(camper, "死亡点蹲守");
              return;
            }
          } catch {}
          // 06-12修：精确认墓碑——gravel(碎石)曾被includes("grave")误捞，喜报装备回来实际背包空
          // 06-13修：①名字查stateIdCache(b.name对mod方块可能没解析) ②扫4轮每轮隔3秒(tiny视距下tp完区块没加载完,扫早了扫空)
          const isGraveBlock = (b) => {
            if (!b) return false;
            const n = stateIdCache[b.stateId] || b.name || "";
            return n.startsWith("forgottengraves:") ||
              /^grave(stone)?(_|$)/.test(n) ||
              n.includes("tombstone") || n.includes("death_chest");
          };
          let found = null;
          for (let attempt = 1; attempt <= 4 && !found; attempt++) {
            if (attempt > 1) await new Promise((r) => setTimeout(r, 3000));
            outer:
            for (let dx = -5; dx <= 5; dx++) {
              for (let dy = -5; dy <= 5; dy++) {
                for (let dz = -5; dz <= 5; dz++) {
                  const block = bot.blockAt(bot.entity.position.offset(dx, dy, dz));
                  if (isGraveBlock(block)) { found = block; break outer; }
                }
              }
            }
            if (!found) log(`[grave] 第${attempt}/4次扫描没找到墓碑${attempt < 4 ? "，3秒后重试" : ""}`);
          }
          if (!found) {
            notifyClaude("[MC] 附近没找到墓碑 可能方块名不一样 需要手动捡", { event: "no_gravestone" });
            return;
          }
          log(`found gravestone: ${found.name} at ${found.position}`);
          try {
            // 06-12修：必须空手右键（煊煊教的），且认实物——背包没变就不报喜
            try { await bot.unequip("hand"); } catch {}
            const before = bot.inventory.items().reduce((s, i) => s + i.count, 0);
            await bot.activateBlock(found);
            await new Promise((r) => setTimeout(r, 1500));
            const after = bot.inventory.items().reduce((s, i) => s + i.count, 0);
            const fp = found.position;
            if (after > before) {
              notifyClaude(`[MC] 墓碑开了！装备回来了(背包${before}→${after}件) tp回煊煊身边`, { event: "gravestone_collected" });
              const owner = bot.nearestEntity((e) => e.type === "player");
              if (owner && owner.username) {
                setTimeout(() => safeChat("/tp " + MC_USERNAME + " " + owner.username), 1000);
              }
            } else {
              notifyClaude(`[MC] 右键了${found.name}但背包没变化(${before}件) 没捡成 墓碑在 ${Math.round(fp.x)},${Math.round(fp.y)},${Math.round(fp.z)} 需要手动`, { event: "gravestone_fail" });
            }
          } catch (e) {
            log(`gravestone interact failed: ${e.message}`);
            notifyClaude(`[MC] 墓碑交互失败: ${e.message}`, { event: "gravestone_fail" });
          }
        }, 2000);
      }, 3000);
    }
  });

  // 捡到物品
  bot.on("playerCollect", (collector, collected) => {
    if (collector.username === bot.username || collector === bot.entity) {
      // debug: dump metadata structure
      if (collected.metadata) {
        const mdDebug = collected.metadata.map((m, i) => {
          if (m && typeof m === 'object') return `[${i}]=${JSON.stringify(m).slice(0, 120)}`;
          return null;
        }).filter(Boolean);
        log(`[ITEM_DEBUG] metadata: ${mdDebug.join(' | ')}`);
      }
      let item = null;
      if (collected.metadata) {
        for (let i = 0; i < collected.metadata.length; i++) {
          if (collected.metadata[i]?.itemStack) { item = collected.metadata[i].itemStack; break; }
        }
      }
      if (item) {
        const rawName = item.name || "unknown";
        const itemName = translateItem(rawName);
        const extra = itemName === rawName ? `(${rawName})` : "";
        notifyClaude(`[MC] 捡到了 ${itemName}${extra}`, { event: "item_collect" });
      } else {
        const before = new Map();
        bot.inventory.items().forEach(i => before.set(i.name, (before.get(i.name) || 0) + i.count));
        setTimeout(() => {
          const diff = [];
          bot.inventory.items().forEach(i => {
            const prev = before.get(i.name) || 0;
            const added = i.count - prev;
            if (added > 0) {
              const translated = translateItem(i.name);
              const extra = translated === i.name ? `(${i.name})` : "";
              diff.push(`${translated}${extra} x${added}`);
              before.set(i.name, i.count);
            }
          });
          if (diff.length > 0) {
            notifyClaude(`[MC] 捡到了 ${diff.join(", ")}`, { event: "item_collect" });
          }
        }, 300);
      }
    }
  });

  // 睡觉/起床
  bot.on("sleep", () => {
    notifyClaude("[MC] 😴 躺下了，正在睡觉", { event: "sleep" });
  });
  bot.on("wake", () => {
    notifyClaude("[MC] 起床了", { event: "wake" });
  });

  // 被踢
  bot.on("kicked", (reason) => {
    if (gen !== botGen) { log(`[gen] 旧bot(gen${gen})的kicked事件,忽略: ${reason}`); return; }
    log(`kicked: ${reason}`);
    connected = false;
    notifyClaude(`[MC] 被踢了: ${reason}`, { event: "kicked" });
  });

  // 断开
  bot.on("end", (reason) => {
    if (gen !== botGen) { log(`[gen] 旧bot(gen${gen})的end事件,忽略: ${reason}`); return; }
    log(`disconnected: ${reason}`);
    connected = false;
    try { stopFollow(); } catch {}
    try { stopViewer(true); } catch {} // 关viewer释放端口,但记住"想开着",重连spawn后自动恢复
  });

  bot.on("error", (err) => {
    if (gen !== botGen) { log(`[gen] 旧bot(gen${gen})的error,忽略: ${err.message}`); return; }
    log(`error: ${err.message}`);
    const socketAlive = bot._client && bot._client.socket && !bot._client.socket.destroyed;
    if (socketAlive) {
      log("(error but socket alive, keeping connected)");
      return;
    }
    connected = false;
  });

  // uncaughtException只注册一次(06-12)：原来每次createBot都process.on一个,connect几次就攒几个handler
  if (!process.__mcUncaughtHooked) {
    process.__mcUncaughtHooked = true;
    process.on("uncaughtException", (err) => {
      log(`uncaught: ${err.message}`);
      const socketAlive = bot && bot._client && bot._client.socket && !bot._client.socket.destroyed;
      if (socketAlive) {
        log("(uncaught error but socket alive, keeping connected)");
        return;
      }
      connected = false;
    });
  }
}

// ===== MCP Server =====

async function main() {
  mcp = new Server(
    { name: "minecraft", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
        },
      },
      instructions: [
        "This is your Minecraft body. You are connected to a MC server via mineflayer.",
        "Messages arrive as <channel source=\"plugin:minecraft:minecraft\" chat_id=\"minecraft\" ...>.",
        "Chat messages from players show their username. System events are prefixed with [MC].",
        "Use the reply tool to chat in game or execute commands.",
        "Use move/follow/attack/tp tools to control your body.",
        "You ARE the bot — decide what to do based on what happens in the game.",
      ].join("\n"),
    }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "Say something in MC chat or run a /command",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "聊天消息或/命令" },
          },
          required: ["text"],
        },
      },
      {
        name: "follow",
        description: "Follow a player (tp-based for modded server)",
        inputSchema: {
          type: "object",
          properties: {
            username: { type: "string", description: "要跟随的玩家名" },
          },
          required: ["username"],
        },
      },
      {
        name: "stop",
        description: "Stop all actions - following, fighting, moving",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "attack",
        description: "Attack nearest hostile mob or a specific target. boss级怪(warden/wither/ender_dragon等或血量>100)会拒绝并建议跑路,确认要打传force:true",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "目标名(zombie/skeleton等,mod怪支持去命名空间匹配)，留空打最近的怪" },
            force: { type: "boolean", description: "true=无视战力评估硬打(boss也上)" },
          },
        },
      },
      {
        name: "tp",
        description: "Teleport to a player or coordinates",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "玩家名或 x y z 坐标" },
          },
          required: ["target"],
        },
      },
      {
        name: "status",
        description: "Get bot status - health, hunger, position, inventory",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "look_around",
        description: "Scan nearby entities - players, mobs, animals",
        inputSchema: {
          type: "object",
          properties: {
            range: { type: "number", description: "扫描范围(格), 默认20" },
            debug: { type: "boolean", description: "显示实体原始字段(排查mod怪分类)" },
          },
        },
      },
      {
        name: "use_item",
        description: "Equip and use an item from inventory",
        inputSchema: {
          type: "object",
          properties: {
            item: { type: "string", description: "物品名(如bow, bread, diamond_sword)" },
          },
          required: ["item"],
        },
      },
      {
        name: "place",
        description: "Place a block from inventory",
        inputSchema: {
          type: "object",
          properties: {
            block: { type: "string", description: "要放的方块名(如cobblestone, dirt, oak_planks)" },
            direction: { type: "string", description: "放置方向: down/up/forward, 默认down" },
          },
          required: ["block"],
        },
      },
      {
        name: "dig",
        description: "Dig/mine the block you're looking at or at relative offset",
        inputSchema: {
          type: "object",
          properties: {
            direction: { type: "string", description: "方向: down/up/forward/below, 默认forward" },
            ultimine: { type: "boolean", description: "true=用FTB Ultimine连锁破坏(挖前自动按住,挖完自动松手,连整条矿脉/整棵树)" },
          },
        },
      },
      {
        name: "interact",
        description: "Right-click a block (open door/chest/bed/button). Supports xyz for mod blocks",
        inputSchema: {
          type: "object",
          properties: {
            direction: { type: "string", description: "方向: down/up/forward, 默认forward" },
            x: { type: "number", description: "x坐标(精确指定)" },
            y: { type: "number", description: "y坐标" },
            z: { type: "number", description: "z坐标" },
          },
        },
      },
      {
        name: "feed",
        description: "Feed an animal or mob - equip food and right-click the nearest matching entity",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "动物名(如wolf, cow, horse)" },
            food: { type: "string", description: "食物名(如bone, wheat, apple)" },
          },
          required: ["target", "food"],
        },
      },
      {
        name: "drop",
        description: "Drop an item from inventory",
        inputSchema: {
          type: "object",
          properties: {
            item: { type: "string", description: "物品名" },
            count: { type: "number", description: "数量，留空丢全部" },
          },
          required: ["item"],
        },
      },
      {
        name: "equip_armor",
        description: "Auto-equip best armor from inventory",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "eat",
        description: "Eat the best food in inventory",
        inputSchema: {
          type: "object",
          properties: {
            item: { type: "string", description: "指定食物名，留空自动选最好的" },
          },
        },
      },
      {
        name: "open_container",
        description: "Open a nearby container (chest/furnace/crafting table) and list contents or deposit/withdraw items",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "list(查看内容)/deposit(放入)/withdraw(取出), 默认list" },
            item: { type: "string", description: "deposit/withdraw时的物品名" },
            count: { type: "number", description: "数量, 默认全部" },
            x: { type: "number", description: "箱子x坐标(精确指定)" },
            y: { type: "number", description: "箱子y坐标" },
            z: { type: "number", description: "箱子z坐标" },
          },
        },
      },
      {
        name: "connect",
        description: "Connect or reconnect to MC server",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "服务器地址" },
            port: { type: "number", description: "端口" },
          },
        },
      },
      {
        name: "disconnect",
        description: "Disconnect from MC server",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "debug_chat",
        description: "Wait for chat events and report what was received (debug tool)",
        inputSchema: {
          type: "object",
          properties: {
            seconds: { type: "number", description: "等待秒数, 默认10" },
          },
        },
      },
      {
        name: "debug_log",
        description: "Read recent debug log entries from /tmp/mc-debug.log",
        inputSchema: {
          type: "object",
          properties: {
            lines: { type: "number", description: "读取行数, 默认30" },
          },
        },
      },
      {
        name: "learn_item",
        description: "Teach the bot about an item - name, usage, how to use, crafting recipe. Can update partial fields.",
        inputSchema: {
          type: "object",
          properties: {
            internal_name: { type: "string", description: "物品内部名(如big_dripleaf)" },
            display_name: { type: "string", description: "中文名(如蘑菇)" },
            usage: { type: "string", description: "用途(如食物、建材、武器)" },
            how_to_use: { type: "string", description: "使用方法" },
            recipe: { type: "string", description: "合成表(如3木板=6木棍)" },
          },
          required: ["internal_name"],
        },
      },
      {
        name: "item_info",
        description: "Look up an item from the dictionary by name (internal or Chinese)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "物品名(内部名或中文名)" },
          },
          required: ["name"],
        },
      },
      {
        name: "craft",
        description: "Craft an item. Finds recipe automatically. Needs a crafting table nearby for 3x3 recipes. Supports recursive crafting (auto-craft intermediates).",
        inputSchema: {
          type: "object",
          properties: {
            item: { type: "string", description: "要合成的物品名(如stick, oak_planks, crafting_table)" },
            count: { type: "number", description: "合成数量, 默认1" },
            recursive: { type: "boolean", description: "递归合成：自动合成缺少的中间件(如做剑先做木棍)。默认false" },
          },
          required: ["item"],
        },
      },
      {
        name: "scan_blocks",
        description: "Scan nearby blocks - find specific block types or see what's around you",
        inputSchema: {
          type: "object",
          properties: {
            range: { type: "number", description: "扫描范围(格), 默认5" },
            blockType: { type: "string", description: "要找的方块名(如jukebox, diamond_ore), 留空列出所有非空气方块" },
            debug: { type: "boolean", description: "显示stateId调试信息" },
          },
        },
      },
      {
        name: "verify_block",
        description: "Ask the server the real block name at a position using /data get block. Learns the correct stateId mapping for future scans.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "x坐标" },
            y: { type: "number", description: "y坐标" },
            z: { type: "number", description: "z坐标" },
          },
          required: ["x", "y", "z"],
        },
      },
      {
        name: "platform_check",
        description: "Check 3x3 ground beneath bot - reports which blocks are solid vs air. Helps avoid falling into holes.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "ultimine",
        description: "FTB Ultimine连锁破坏(挖一块连整条矿脉/整棵树): on=按住激活键(⚠️之后挖任何方块都连锁,小心别拆到建筑,用完记得off) / off=松开 / status=看状态。单次挖矿建议直接给dig/find_and_dig传ultimine:true,自动按住挖完自动松手。连锁很吃饥饿,挖前吃饱",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "on/off/status,默认status" },
          },
        },
      },
      {
        name: "sneak",
        description: "潜行开关(深暗之域防sculk sensor听脚步引Warden): on=按住shift潜行(移动变慢,follow/追击也慢;其他动作清控制键后会自动重新按住) / off=解除 / status。⚠️stop急停【不会】解除潜行(潜行是姿态不是动作,慌乱中突然变响更危险),解除只能sneak off;断线重连后默认解除",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "on/off/status,默认status" },
          },
        },
      },
      {
        name: "viewer",
        description: "bot视角3D渲染(prismarine-viewer): on=起本机web服务 http://localhost:3007 (第一人称) / off=关掉 / status。看画面:Playwright browser_navigate到该地址→等3~5秒方块流完→browser_take_screenshot。mod方块显示紫黑missing texture属正常,原版地形/实体能看清。断线重连后自动恢复,失败再on一次",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "on/off/status,默认status" },
          },
        },
      },
      {
        name: "trinket",
        description: "配饰槽(Trinkets mod): info查看45+扩展槽 / put放进指定槽 / take取回。★装配饰优先用 use_item <物品>，Trinkets 会自动入对的槽(artifacts配饰如bunny_hoppers/pocket_piston不是盔甲，equip_armor认不出是正常的，别手动 put 到45号槽——那不一定是对应部位)。",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "info(默认)/put/take" },
            item: { type: "string", description: "put时的物品名" },
            slot: { type: "number", description: "put/take的槽位号(先用info看)" },
          },
        },
      },
      {
        name: "find_and_dig",
        description: "Find a specific block type nearby, walk to it, and dig multiple blocks. 优先裸露矿、深埋的(隧道>maxTunnel格)跳过、挖完pillar爬回原地不留坑、浮空方块垫脚够。Returns collected count.",
        inputSchema: {
          type: "object",
          properties: {
            blockType: { type: "string", description: "要挖的方块名(如dirt, cobblestone, oak_log)，也支持类别词 wood/ore/oak" },
            count: { type: "number", description: "要挖几个, 默认10" },
            range: { type: "number", description: "搜索范围, 默认30" },
            maxTunnel: { type: "number", description: "深度闸：要挖穿超过这么多格才够到的矿直接放弃，默认5。设大可挖深埋矿" },
            climbBack: { type: "boolean", description: "挖完是否pillar爬回出发高度(填竖井不留坑)，默认true" },
            ultimine: { type: "boolean", description: "true=每次挖用FTB Ultimine连锁破坏(一镐连整条矿脉,count可以给小点;连锁很吃饥饿)" },
          },
          required: ["blockType"],
        },
      },
      {
        name: "build",
        description: "Build a simple structure (walls/floor/roof) at given position. Places blocks from inventory.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "起始x坐标(西南角)" },
            y: { type: "number", description: "起始y坐标(地面)" },
            z: { type: "number", description: "起始z坐标(西南角)" },
            width: { type: "number", description: "宽度(x方向), 默认6" },
            depth: { type: "number", description: "深度(z方向), 默认6" },
            height: { type: "number", description: "高度, 默认4" },
            block: { type: "string", description: "使用的方块名(如dirt, cobblestone), 默认用背包里最多的建筑方块" },
            part: { type: "string", description: "建造部分: walls(墙)/floor(地板)/roof(屋顶)/all(全部), 默认all" },
          },
          required: ["x", "y", "z"],
        },
      },
      {
        name: "farm",
        description: "Farming automation - plant seeds, harvest mature crops, or auto (harvest+replant). Works with vanilla and mod crops.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "plant(种)/harvest(收)/auto(收+种), 默认auto" },
            seed: { type: "string", description: "种子名(如wheat_seeds, beetroot_seeds), 留空自动选背包里的种子" },
            range: { type: "number", description: "搜索范围, 默认15" },
          },
        },
      },
      {
        name: "smelt",
        description: "Smelt items in a furnace. Can start smelting, check progress, or collect output. Furnace keeps working after you walk away.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", description: "start(放料+燃料开炼)/check(查看熔炉状态)/collect(取出成品)/list(列出附近所有熔炉状态), 默认start" },
            input: { type: "string", description: "要冶炼的物品名(如raw_iron, raw_gold, cobblestone)" },
            fuel: { type: "string", description: "燃料名(如coal, charcoal, oak_planks), 默认自动选背包里的燃料" },
            count: { type: "number", description: "冶炼数量, 默认背包里所有该物品" },
            x: { type: "number", description: "熔炉x坐标(精确指定)" },
            y: { type: "number", description: "熔炉y坐标" },
            z: { type: "number", description: "熔炉z坐标" },
          },
        },
      },
    ],
  }));

  let followInterval = null;
  let followName = null;

  // 跟随时的门处理：pathfinder(canOpenDoors)负责开门，这里负责【走远了把开过的门关上】——
  // 不当只开不关的太子爷。扫 bot 附近开着的门记下来，等 bot 走出 2.5 格再 activateBlock 关回去。
  const isDoorBlock = (b) => b && /(^|_)door$/.test(b.name) && !b.name.includes("trapdoor");
  const isDoorOpen = (b) => {
    try { const o = b.getProperties().open; return o === true || o === "true"; } catch { return false; }
  };
  function handleFollowDoors() {
    if (!bot._followDoors) bot._followDoors = [];
    const p = bot.entity.position;
    // 门是上下两格(同一x,z两个door方块)，按列(x,z)去重，一扇门一个tick只toggle一次(否则开两次=白开)
    const handledCols = new Set();
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const bp = _v3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
      const b = bot.blockAt(bp);
      if (!isDoorBlock(b)) continue;
      const col = `${bp.x},${bp.z}`;
      if (handledCols.has(col)) continue;
      handledCols.add(col);
      const horiz = Math.hypot(bp.x + 0.5 - p.x, bp.z + 0.5 - p.z);
      const rec = bot._followDoors.find((d) => d.col === col);
      // 第一次贴近这扇门(还没记录过)才处理，之后绝不再碰——避免 isDoorOpen 读不准导致每tick狂toggle闪门
      if (!rec && horiz <= 2.2) {
        if (isDoorOpen(b)) {
          bot._followDoors.push({ col, pos: bp, opened: false }); // 本来就开着(玩家开的)，别碰，也别帮忙关
        } else {
          try { bot.activateBlock(b); log(`[follow door] 开门 ${col}`); } catch (e) { log(`[follow door] 开门失败: ${e.message}`); }
          bot._followDoors.push({ col, pos: bp, opened: true });
        }
      }
    }
    // 走出 2.6 格(水平)：只关我们开过的门，toggle 一次，移除
    bot._followDoors = bot._followDoors.filter((d) => {
      const horiz = Math.hypot(d.pos.x + 0.5 - p.x, d.pos.z + 0.5 - p.z);
      if (horiz <= 2.6) return true; // 还在跟前，先留着
      if (d.opened) {
        const b = bot.blockAt(d.pos);
        if (isDoorBlock(b)) { try { bot.activateBlock(b); log(`[follow door] 关门 ${d.col}`); } catch {} }
      }
      return false;
    });
  }

  // 跟随重构(2026-05-31)：寻路通了→用 GoalFollow 动态跟随(pathfinder 自己持续重算路径)，
  // 不再 setControlState 硬走(会触发 invalid_player_movement 被踢)，也不再>5就tp(太死板)。
  // 只有超 30 格(pathfinder 算不动/玩家瞬移)才 tp 兜底。
  function startFollow(username) {
    stopFollow();
    followName = username;
    try { if (bot._followMovements) bot.pathfinder.setMovements(bot._followMovements); } catch {} // 跟随不拆方块
    const { GoalFollow } = goals;
    followInterval = setInterval(() => {
      if (!bot || !connected) { log("[follow] skip: bot=" + !!bot + " connected=" + connected); return; }
      // try { handleFollowDoors(); } catch (e) { log("[follow door] " + e.message); } // 关了——煊煊嫌门口站着一直开关
      if (bot.pvp && bot.pvp.target) { log("[follow] skip: pvp combat"); return; }
      if (bot._engaging) { return; } // meleeEngage战斗中,follow别抢控制权
      // 被扛检测(06-12重写)：信set_passengers包,不再搞10秒超时强制清除——
      // 旧逻辑扛超10秒就当"vehicle卡死"清掉→follow恢复→对着她疯狂tp→tp强制dismount→她再扛→循环
      const packetSaysCarried = bot._carriedVehicleId != null;
      if (bot.vehicle || packetSaysCarried) {
        const v = bot.vehicle || (packetSaysCarried ? bot.entities[bot._carriedVehicleId] : null);
        // 只有包没说扛着时,才用实体消失/距离过远兜底清除(防真卡死);包说扛着就绝对信包
        const vGone = !packetSaysCarried && (!v || !v.position || v.isValid === false || (v.id !== undefined && !bot.entities[v.id]));
        const vFar = !packetSaysCarried && v && v.position && bot.entity.position.distanceTo(v.position) > 8;
        if (vGone || vFar) {
          log(`[follow] vehicle状态失效(gone=${vGone} far=${vFar}) → 清除`);
          try { bot.dismount(); } catch {}
          bot.vehicle = null;
          bot._carriedVehicleId = null;
          bot._carriedSince = null;
        } else {
          bot._followWasCarried = true; return; // 被扛着:乖乖待着,绝不tp绝不寻路
        }
      } else {
        bot._carriedSince = null;
      }
      if (bot._followWasCarried) { bot._followWasCarried = false; bot._followStuck = 0; bot._followLastDist = undefined; log("[follow] 放下了，恢复跟随"); }
      // tp统一出口(06-12)：5秒冷却。tp命令会在服务器排队延迟生效,连发会攒一串旧tp陆续把bot拽飞
      const tpToHer = (why) => {
        const now = Date.now();
        if (now - (bot._lastFollowTp || 0) < 5000) { log(`[follow] tp冷却中,跳过(${why})`); return; }
        bot._lastFollowTp = now;
        log(`[follow] tp兜底(${why})`);
        try { bot.pathfinder.setGoal(null); } catch {}
        // 别 tp 到她坐标上——会脸贴脸挡准星/挡她操作(她原话"你贴我太紧了，我操作不了东西")。
        // 落在她旁边 ~2 格(朝 bot 现在的方向偏，不越过她)。实体没加载拿不到坐标时才只能按名字 tp 到她身上。
        const pe = bot.players[username] && bot.players[username].entity;
        if (pe && pe.position) {
          const from = bot.entity.position;
          const dir = from.minus(pe.position);
          const h = Math.hypot(dir.x, dir.z) || 1;
          const off = 2;
          const tx = (pe.position.x + (dir.x / h) * off).toFixed(2);
          const tz = (pe.position.z + (dir.z / h) * off).toFixed(2);
          safeChat(`/tp ${bot.username} ${tx} ${pe.position.y.toFixed(2)} ${tz}`);
        } else {
          safeChat("/tp " + bot.username + " " + username);
        }
      };
      const player = bot.players[username];
      if (!player) return; // 玩家下线了
      if (!player.entity) {
        // 玩家走太远→实体没加载→拿不到坐标。不能 return 干站着(那才是"卡住")，直接 tp 过去。
        tpToHer("实体未加载");
        bot._followStuck = 0;
        return;
      }
      const me = bot.entity.position;
      const dist = me.distanceTo(player.entity.position);
      if (dist > 30) {
        // 太远，寻路算不动，直接 tp 兜底，到了之后下一轮重新挂 GoalFollow
        tpToHer(`太远dist=${dist.toFixed(0)}`);
        bot._followStuck = 0;
        return;
      }
      // 卡住检测：离太远(>5)又没在【靠近】她(到她的距离没缩小)→累计；连续3次(~4.5s)tp兜底。
      // 阈值从 2 提到 5：舒适距离(2~4格)不算卡住，免得 bot 在她身边被判"卡住"又 tp 贴上去。
      // 用"到目标的距离有没有缩小"判断，比看原地挪没挪更准(原地来回晃也算卡住)。门/墙/犄角都能救。
      if (dist > 5) {
        const last = bot._followLastDist;
        if (last !== undefined && dist > last - 0.4) {
          bot._followStuck = (bot._followStuck || 0) + 1;
          if (bot._followStuck >= 3) {
            tpToHer(`卡住${bot._followStuck}次 dist=${dist.toFixed(1)} last=${last.toFixed(1)} pos=${me.x.toFixed(0)},${me.y.toFixed(0)},${me.z.toFixed(0)} isMoving=${bot.pathfinder.isMoving()}`);
            bot._followStuck = 0;
            bot._followLastDist = undefined;
            return;
          }
        } else {
          bot._followStuck = 0;
        }
      } else {
        bot._followStuck = 0;
      }
      bot._followLastDist = dist;
      // 动态 GoalFollow：目标变了/没在走/目标实体重载了才重新 setGoal，避免每轮打断寻路
      try {
        const g = bot.pathfinder.goal;
        const sameTarget = g && g.entity && g.entity.id === player.entity.id;
        if (!sameTarget || !bot.pathfinder.isMoving()) {
          bot.pathfinder.setGoal(new GoalFollow(player.entity, 3), true); // dynamic=true·range3留出空间(range1会贴脸挡她操作;门处理已关，不怕"开门而不入")
        }
      } catch (e) {
        log("[follow] " + e.message);
      }
    }, 1500);
  }

  function stopFollow() {
    followName = null;
    if (bot) bot._followDoors = [];
    if (followInterval) {
      clearInterval(followInterval);
      followInterval = null;
    }
    if (bot) {
      try { bot.pathfinder.setGoal(null); } catch {}
      try { bot.pathfinder.stop(); } catch {}
      try { bot.clearControlStates(); } catch {}
      try { bot.pvp.stop(); } catch {}
      try { if (bot._digMovements) bot.pathfinder.setMovements(bot._digMovements); } catch {} // 跟随结束恢复挖矿用的canDig
    }
  }

  // ===== 挖矿大改辅助函数(2026-05-31) =====
  const _v3 = require("vec3");
  const AIRY = new Set(["air", "cave_air", "void_air"]);
  function isAiry(b) {
    if (!b) return true;
    const n = (stateIdCache[b.stateId] || b.name || "").replace("minecraft:", "");
    return AIRY.has(n);
  }
  // 一个方块周围6面有几面是空气（裸露程度）
  function exposedFaces(bpos) {
    let c = 0;
    const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [dx,dy,dz] of dirs) {
      if (isAiry(bot.blockAt(_v3(bpos.x+dx, bpos.y+dy, bpos.z+dz)))) c++;
    }
    return c;
  }
  // 沿直线从 from→to 经过几个固体方块(估算要挖穿的隧道长度，不含目标本身)
  function tunnelCost(from, to) {
    const dir = to.minus(from);
    const len = dir.norm();
    if (len < 0.01) return 0;
    const steps = Math.ceil(len * 2);
    const seen = new Set();
    const tx = Math.floor(to.x), ty = Math.floor(to.y), tz = Math.floor(to.z);
    let count = 0;
    for (let i = 1; i <= steps; i++) {
      const p = from.plus(dir.scaled(i / steps));
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      const key = bx + "," + by + "," + bz;
      if (seen.has(key)) continue;
      seen.add(key);
      if (bx === tx && by === ty && bz === tz) continue; // 目标本身不算
      if (!isAiry(bot.blockAt(_v3(bx, by, bz)))) count++;
    }
    return count;
  }
  // 垫脚/爬回(④垫脚 + ③挖完爬回共用)：手搓塔升。
  // 关键(踩过两次坑)：参考方块要在【起跳前】锁定脚下那块实心，到最高点时往脚的原位放——
  // 不能在跳起来之后再取脚下方块(那时已是空气，放不上)。pathfinder 的 GoalBlock 直上直下算不出来，弃用。
  async function pillarUp(targetY, maxBlocks = 24) {
    const fillKeys = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone"];
    const goal = Math.ceil(targetY);
    let placed = 0, stuck = 0;
    // 抗漂移：先停掉所有移动+让残余横向速度衰减，pillar 全程不能有横向输入(否则站歪→放偏→卡)
    try { bot.pathfinder.setGoal(null); } catch {}
    try { bot.clearControlStates(); } catch {}
    await new Promise((r) => setTimeout(r, 350));
    while (Math.floor(bot.entity.position.y) < goal && placed < maxBlocks && stuck < 4) {
      const item = bot.inventory.items().find((i) => fillKeys.some((f) => i.name.includes(f)));
      if (!item) { log("[pillar] 没垫脚方块了，停止"); break; }
      try { await bot.equip(item, "hand"); } catch {}
      // 每格重新对正格子中心 + 锁定起跳前脚下那块实心(参考方块)
      const fx = Math.floor(bot.entity.position.x), fz = Math.floor(bot.entity.position.z);
      const fy = Math.floor(bot.entity.position.y);
      const feet = _v3(fx, fy, fz);
      let ref = bot.blockAt(feet.offset(0, -1, 0));
      if (!ref || isAiry(ref)) { ref = bot.blockAt(feet.offset(0, -2, 0)); }
      if (!ref || isAiry(ref)) { stuck++; await new Promise(r => setTimeout(r, 200)); continue; }
      try { bot.clearControlStates(); } catch {}      // 杀横向
      try { await bot.look(bot.entity.yaw, -Math.PI / 2, true); } catch {} // 看正下方
      bot.setControlState("jump", true);
      await new Promise((r) => setTimeout(r, 420));    // 到最高点(~+1.25格)，脚原位空出来
      let ok = false;
      try {
        const r0 = bot.blockAt(feet.offset(0, -1, 0)) || ref;
        if (r0 && !isAiry(r0)) { await bot.placeBlock(r0, _v3(0, 1, 0)); ok = true; }
      } catch (e) { /* 时机/碰撞偶发抛错，靠循环重试 */ }
      bot.setControlState("jump", false);
      await new Promise((r) => setTimeout(r, 380));    // 落到新方块上
      const yA = Math.floor(bot.entity.position.y);
      if (yA > fy) { placed++; stuck = 0; }
      else { stuck++; log(`[pillar] 第${placed + 1}格没升上去(ok=${ok} y${fy}→${yA})，重试 stuck=${stuck}`); }
    }
    try { bot.clearControlStates(); } catch {}
    log(`[pillar] 结束：垫了${placed}格，现在y=${Math.floor(bot.entity.position.y)}/目标${goal}`);
    return placed;
  }

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    if (name === "debug_log") {
      try {
        const content = fs.readFileSync(DEBUG_LOG, "utf8");
        const allLines = content.split("\n").filter(Boolean);
        const n = args.lines || 30;
        const recent = allLines.slice(-n);
        return { content: [{ type: "text", text: recent.join("\n") || "(空)" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `读取日志失败: ${e.message}` }] };
      }
    }

    if (!bot || !connected) {
      if (name === "connect") {
        const h = args.host || MC_HOST;
        const p = args.port || MC_PORT;
        createBot(h, p);
        return { content: [{ type: "text", text: `正在连接 ${h}:${p}...` }] };
      }
      return { content: [{ type: "text", text: "未连接MC服务器，用connect工具连接" }] };
    }

    switch (name) {
      case "reply": {
        safeChat(args.text);
        return { content: [{ type: "text", text: `sent: ${args.text}` }] };
      }

      case "follow": {
        const who = args.username || args.player || args.target;
        startFollow(who);
        return { content: [{ type: "text", text: `开始跟随 ${who}` }] };
      }

      case "stop": {
        stopFollow();
        if (currentTask) { currentTask.interrupted = true; currentTask = null; }
        try { bot.pathfinder.setGoal(null); } catch {}
        try { bot.pathfinder.stop(); } catch {}
        try { bot.stopDigging(); } catch {}
        try { if (bot.pvp) bot.pvp.stop(); } catch {}
        try { if (bot._ultiminePressed) ultimineSetPressed(false); } catch {} // 连锁破坏也松手,别留着到处连锁
        // 注意:潜行(sneak)【故意不清】——潜行是姿态不是动作,深暗之域里急停瞬间站起来变响反而引Warden。解除用sneak off
        return { content: [{ type: "text", text: `已停止所有动作${bot._sneakLocked ? "(潜行保持着,解除用 sneak off)" : ""}` }] };
      }

      case "attack": {
        const target = args.target;
        let entity;
        if (target) {
          const t = target.toLowerCase();
          const tBare = t.includes(":") ? t.split(":").pop() : t; // 去命名空间: "species:limpet"→"limpet"
          entity = bot.nearestEntity((e) => {
            if (!e || e === bot.entity || !e.position) return false;
            if (bot.entity.position.distanceTo(e.position) >= 16) return false;
            if (classifyEntity(e) === "ignore") return false; // 掉落物/经验球/投射物不是攻击目标
            // mod怪的 e.name 常是 undefined/"unknown"，真名藏在 entity_type 注册表里(entityRealName取)——
            // 旧代码只查 e.name/displayName，所以 target="limpet"/"species:limpet" 都匹配不到，只有留空才锁到"unknown"。
            // 这里把 registry 真名也拼进来，并对名字和目标各做一次去命名空间，子串匹配。
            const parts = [e.name, e.displayName, e.username, entityRealName(e)].filter(Boolean).map((s) => String(s).toLowerCase());
            const hay = parts.join(" ");
            const hayBare = parts.map((s) => (s.includes(":") ? s.split(":").pop() : s)).join(" ");
            return hay.includes(t) || hay.includes(tBare) || hayBare.includes(t) || hayBare.includes(tBare);
          });
        } else {
          entity = bot.nearestEntity((e) => {
            const c = classifyEntity(e);
            return (c === "hostile" || c === "unknown_mob") && bot.entity.position.distanceTo(e.position) < 16;
          });
        }
        if (entity) {
          // 战力评估劝退(2026-07-05 铁剑硬刚Warden死6次)：名单怪/血量>100的,不带force不打
          if (!args.force) {
            const foeDesc = `${entity.name || ""} ${entity.displayName || ""} ${entityRealName(entity)}`;
            const foeMaxHp = getMaxHealth(entity);
            if (UNBEATABLE_RE.test(foeDesc)) {
              return { content: [{ type: "text", text: `${entityRealName(entity)} 在打不过名单里(boss级${foeMaxHp ? `,${foeMaxHp}血` : ""})，建议跑路。非要头铁传 force:true` }] };
            }
            if (foeMaxHp && foeMaxHp > 100) {
              return { content: [{ type: "text", text: `${entityRealName(entity)} 最大血量${foeMaxHp}，血牛大概率打不过，建议跑路。非要头铁传 force:true` }] };
            }
          }
          // 06-12：改用meleeEngage锁定循环(锁脸+追击+按冷却连打)，pvp插件在mod服基本是站桩空挥
          if (bot._meleeEngage) {
            bot._meleeEngage(entity.id, "attack指令").catch((e) => log(`[engage] ${e.message}`));
            return { content: [{ type: "text", text: `锁定攻击 ${entity.username || entity.name || entity.displayName}！(追击+连打模式)` }] };
          }
          const weapon = equipBestWeapon();
          bot.pvp.attack(entity);
          return { content: [{ type: "text", text: `攻击 ${entity.username || entity.name}！武器: ${weapon || "拳头"}` }] };
        }
        return { content: [{ type: "text", text: "附近没有目标" }] };
      }

      case "tp": {
        const dest = args.target || args.player;
        safeChat("/tp " + bot.username + " " + dest);
        return { content: [{ type: "text", text: `传送到 ${dest}` }] };
      }

      case "status": {
        const items = bot.inventory.items();
        const itemList = items.slice(0, 15).map((i) => `${translateItem(i.name)}x${i.count}`).join(", ");
        const pos = bot.entity.position;
        return {
          content: [{
            type: "text",
            text: `血量: ${Math.round(bot.health)}/20\n饥饿: ${Math.round(bot.food)}/20\n位置: ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}\n背包: ${itemList || "空"}`,
          }],
        };
      }

      case "look_around": {
        const range = args.range || 20;
        const entities = Object.values(bot.entities).filter(
          (e) => e !== bot.entity && bot.entity.position.distanceTo(e.position) < range
        );
        const players = entities.filter((e) => e.type === "player").map((e) => e.username);
        const buckets = { hostile: [], animal: [], unknown_mob: [], other: [] };
        for (const e of entities) {
          const c = classifyEntity(e);
          if (buckets[c]) {
            let nm = entityRealName(e); // 06-12:mod实体用entity_type表查真名,不再一排unknown
            if (!nm || nm === "?" || nm === "unknown") nm = `?[type=${e.type || "?"},et=${e.entityType ?? "?"}]`; // 07-06:认不出的也别隐身,给raw线索
            buckets[c].push(nm);
          }
        }
        const countUp = (arr) => {
          const m = {};
          arr.forEach((n) => { m[n] = (m[n] || 0) + 1; });
          return Object.entries(m).map(([k, v]) => `${k}x${v}`).join(", ");
        };
        let text = `周围${range}格:\n玩家: ${players.join(", ") || "无"}\n怪物: ${countUp(buckets.hostile) || "无"}\n动物: ${countUp(buckets.animal) || "无"}`;
        if (buckets.unknown_mob.length > 0) text += `\n不明生物(疑似mod怪): ${countUp(buckets.unknown_mob)}`;
        if (buckets.other.length > 0) text += `\n其他: ${countUp(buckets.other)}`;
        if (args.debug) {
          const dump = entities.slice(0, 25).map((e) => `${e.name || "?"}|dn=${e.displayName || "?"}|type=${e.type || "?"}|kind=${e.kind || "?"}|et=${e.entityType ?? "?"}|d=${bot.entity.position.distanceTo(e.position).toFixed(1)}`).join("\n");
          text += `\n[debug]\n${dump}`;
        }
        return { content: [{ type: "text", text }] };
      }

      case "use_item": {
        const item = bot.inventory.items().find((i) => i.name.includes(args.item));
        if (item) {
          await bot.equip(item, "hand");
          if (item.name.includes("bow") || item.name.includes("crossbow")) {
            return { content: [{ type: "text", text: `装备了${item.name}，用reply发'/射'来射击` }] };
          }
          if (item.name.includes("splash") || item.name.includes("lingering")) {
            bot.activateItem();
            return { content: [{ type: "text", text: `砸了${item.name}！` }] };
          }
          if (item.name.includes("potion")) {
            await bot.consume().catch(() => {});
            return { content: [{ type: "text", text: `喝了${item.name}` }] };
          }
          if (item.name.includes("bread") || item.name.includes("apple") || item.name.includes("cooked") || item.name.includes("steak") || item.name.includes("carrot") || item.name.includes("food") || item.name.includes("berry")) {
            await bot.consume().catch(() => {});
            return { content: [{ type: "text", text: `吃了${item.name}` }] };
          }
          bot.activateItem();
          return { content: [{ type: "text", text: `使用了${item.name}` }] };
        }
        return { content: [{ type: "text", text: `背包里没有${args.item}` }] };
      }

      case "dig": {
        const dir = args.direction || "forward";
        const pos = bot.entity.position;
        let target;
        if (dir === "down" || dir === "below") {
          target = bot.blockAt(pos.offset(0, -1, 0));
        } else if (dir === "up") {
          target = bot.blockAt(pos.offset(0, 2, 0));
        } else {
          const yaw = bot.entity.yaw;
          const dx = -Math.sin(yaw);
          const dz = -Math.cos(yaw);
          target = bot.blockAt(pos.offset(Math.round(dx), 0, Math.round(dz)));
          if (!target || target.name === "air") {
            target = bot.blockAt(pos.offset(Math.round(dx), 1, Math.round(dz)));
          }
        }
        if (!target || target.name === "air") {
          return { content: [{ type: "text", text: `${dir}方向没有可挖的方块` }] };
        }
        try {
          // ultimine: 挖前按住,挖完(finally)必松手——bot.dig默认forceLook会先看向方块,正好满足服务端ray-trace定连锁起点
          if (args.ultimine) ultimineSetPressed(true);
          await bot.dig(target);
          return { content: [{ type: "text", text: `挖掉了 ${target.name}${args.ultimine ? "(连锁破坏,周围同类方块应该一起碎了)" : ""}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `挖不动: ${e.message}` }] };
        } finally {
          if (args.ultimine) ultimineSetPressed(false);
        }
      }

      case "place": {
        const dir = args.direction || "down";
        const itemName = args.block;
        if (!itemName) {
          return { content: [{ type: "text", text: "要放什么方块？" }] };
        }
        const item = bot.inventory.items().find((i) => i.name.includes(itemName));
        if (!item) {
          return { content: [{ type: "text", text: `背包里没有${itemName}` }] };
        }
        await bot.equip(item, "hand");
        const pos = bot.entity.position;
        let refBlock;
        if (dir === "down") {
          refBlock = bot.blockAt(pos.offset(0, -1, 0));
        } else if (dir === "up") {
          refBlock = bot.blockAt(pos.offset(0, 2, 0));
        } else {
          const yaw = bot.entity.yaw;
          const dx = -Math.sin(yaw);
          const dz = -Math.cos(yaw);
          refBlock = bot.blockAt(pos.offset(Math.round(dx), 0, Math.round(dz)));
        }
        if (!refBlock || refBlock.name === "air") {
          return { content: [{ type: "text", text: `${dir}方向没有参考方块可以放置` }] };
        }
        try {
          await bot.placeBlock(refBlock, new (require("vec3"))(0, 1, 0));
          return { content: [{ type: "text", text: `放置了 ${item.name}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `放不了: ${e.message}` }] };
        }
      }

      case "interact": {
        const Vec3 = require("vec3");
        let target;
        if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
          target = bot.blockAt(new Vec3(args.x, args.y, args.z));
          // 墓碑自动清手(06-13)：forgottengraves只认空手右键。手里攥着树苗点了俩回合没反应,煊煊一句"你得空手"破案
          try {
            const tn = (target && (stateIdCache[target.stateId] || target.name)) || "";
            if (tn.startsWith("forgottengraves:") && bot.heldItem) {
              await bot.unequip("hand");
              log(`[interact] 墓碑前自动清手`);
            }
          } catch (e) { log(`[interact] 清手失败: ${e.message}`); }
          if (target && (target.name === "air" || !target.name)) {
            const realName = stateIdCache[target.stateId];
            if (realName) {
              target.name = realName;
            } else {
              try {
                await bot.activateBlock(target);
                return { content: [{ type: "text", text: `强制右键了 ${args.x},${args.y},${args.z} (未知方块 sid:${target.stateId})` }] };
              } catch (e) {
                return { content: [{ type: "text", text: `交互失败: ${e.message}` }] };
              }
            }
          }
        } else {
          const dir = args.direction || "forward";
          const pos = bot.entity.position;
          if (dir === "down") {
            target = bot.blockAt(pos.offset(0, -1, 0));
          } else if (dir === "up") {
            target = bot.blockAt(pos.offset(0, 2, 0));
          } else {
            const yaw = bot.entity.yaw;
            const dx = -Math.sin(yaw);
            const dz = -Math.cos(yaw);
            target = bot.blockAt(pos.offset(Math.round(dx), 0, Math.round(dz)));
            if (!target || target.name === "air") {
              target = bot.blockAt(pos.offset(Math.round(dx), 1, Math.round(dz)));
            }
          }
          if (!target || target.name === "air") {
            return { content: [{ type: "text", text: `${dir}方向没有可交互的方块` }] };
          }
        }
        try {
          const displayName = stateIdCache[target.stateId] || target.name;
          const isBed = displayName.includes("bed");
          if (isBed) {
            try {
              await bot.sleep(target);
              return { content: [{ type: "text", text: `躺下了 ${displayName} 😴 正在睡觉` }] };
            } catch (sleepErr) {
              // bot.sleep failed — fall back to activateBlock to at least set spawn
              try {
                await bot.activateBlock(target);
              } catch (_) {}
              return { content: [{ type: "text", text: `无法睡觉: ${sleepErr.message}（已右键设重生点）` }] };
            }
          }
          await bot.activateBlock(target);
          return { content: [{ type: "text", text: `右键了 ${displayName}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `交互失败: ${e.message}` }] };
        }
      }

      case "feed": {
        const foodItem = bot.inventory.items().find((i) => i.name.includes(args.food));
        if (!foodItem) {
          return { content: [{ type: "text", text: `背包里没有${args.food}` }] };
        }
        const entity = bot.nearestEntity((e) =>
          e.name && e.name.includes(args.target) &&
          e !== bot.entity &&
          bot.entity.position.distanceTo(e.position) < 10
        );
        if (!entity) {
          return { content: [{ type: "text", text: `附近没有${args.target}` }] };
        }
        try {
          await bot.equip(foodItem, "hand");
          await bot.useOn(entity);
          return { content: [{ type: "text", text: `用${foodItem.name}喂了${entity.name || entity.displayName || args.target}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `喂食失败: ${e.message}` }] };
        }
      }

      case "drop": {
        const item = bot.inventory.items().find((i) => i.name.includes(args.item));
        if (!item) {
          return { content: [{ type: "text", text: `背包里没有${translateItem(args.item)}` }] };
        }
        try {
          const amt = args.count || item.count;
          if (amt >= item.count) {
            await bot.clickWindow(item.slot, 0, 0);
            await bot.clickWindow(-999, 0, 0);
          } else {
            for (let i = 0; i < amt; i++) {
              await bot.clickWindow(item.slot, 0, 1);
              await bot.clickWindow(-999, 0, 0);
            }
          }
          return { content: [{ type: "text", text: `丢了 ${translateItem(item.name)}x${amt}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `丢不了: ${e.message}` }] };
        }
      }

      case "equip_armor": {
        // 06-12重写：按名字判部位(含mod盔甲如archers:archer_armor_head)，穿完核实槽位。
        // 删掉了旧的"暴力尝试"fallback——它会把背包里所有东西挨个往头上塞(铁砧戴头上那种)。
        // 名字不对=映射坏了，该修映射，不该乱穿。
        const slotOf = (n) => {
          if (/helmet|_head$|_skull|_cap$|_hood$/.test(n)) return "head";
          if (/chestplate|_chest$|_torso$|_tunic$|_vest$/.test(n)) return "torso";
          if (/leggings|_legs$|_pants$|_leggings$/.test(n)) return "legs";
          if (/boots|_feet$|_shoes$|_sandals$/.test(n)) return "feet";
          return null;
        };
        const armorPriority = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
        const rank = (n) => { const i = armorPriority.findIndex((m) => n.includes(m)); return i === -1 ? armorPriority.length : i; };
        const slotIndex = { head: 5, torso: 6, legs: 7, feet: 8 }; // 玩家背包窗口的盔甲槽位
        const bySlot = { head: [], torso: [], legs: [], feet: [] };
        for (const item of bot.inventory.items()) {
          const s = slotOf(item.name || "");
          if (s) bySlot[s].push(item);
        }
        const equipped = [];
        for (const slot of ["head", "torso", "legs", "feet"]) {
          const list = bySlot[slot];
          if (!list.length) continue;
          list.sort((a, b) => rank(a.name) - rank(b.name));
          const best = list[0];
          try {
            await bot.equip(best, slot);
            await new Promise((r) => setTimeout(r, 300));
            const now = bot.inventory.slots[slotIndex[slot]];
            if (now && now.type === best.type) equipped.push(`${slot}: ${best.name} ✅`);
            else equipped.push(`${slot}: ${best.name} 发出去了但槽位没核实到(现在是${now ? now.name : "空"})`);
          } catch (e) {
            equipped.push(`${slot}: ${best.name} 穿不上 ${e.message}`);
          }
        }
        if (!equipped.length) {
          const inv = bot.inventory.items().map((i) => `${i.name}(id:${i.type})`).join(", ");
          return { content: [{ type: "text", text: `背包里按名字没认出盔甲。如果明明有盔甲,说明物品映射又坏了(报名字给我看)。背包: ${inv || "空"}` }] };
        }
        return { content: [{ type: "text", text: `穿戴结果:\n${equipped.join("\n")}` }] };
      }

      case "eat": {
        // 07-06：金苹果/附魔金挪到队尾——无参eat="随便吃点"不是"把神器吃了"；指定item="golden_apple"才动它
        const foodPriority = ["cooked_beef", "steak", "cooked_porkchop", "cooked_mutton", "cooked_salmon", "cooked_chicken", "cooked_rabbit", "cooked_cod", "bread", "baked_potato", "apple", "carrot", "beetroot", "melon_slice", "sweet_berries", "cookie", "golden_apple", "enchanted_golden_apple"];
        let food = null;
        if (args.item) {
          food = bot.inventory.items().find((i) => i.name.includes(args.item));
        } else {
          for (const name of foodPriority) {
            food = bot.inventory.items().find((i) => i.name === name);
            if (food) break;
          }
          if (!food) {
            food = bot.inventory.items().find((i) =>
              i.name.includes("cooked") || i.name.includes("bread") || i.name.includes("apple") || i.name.includes("steak") || i.name.includes("carrot") || i.name.includes("potato")
            );
          }
        }
        if (!food) {
          return { content: [{ type: "text", text: "背包里没有吃的" }] };
        }
        try {
          await bot.equip(food, "hand");
          await bot.consume();
          return { content: [{ type: "text", text: `吃了 ${food.name} 饥饿值: ${Math.round(bot.food)}/20` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `吃不了: ${e.message}` }] };
        }
      }

      case "open_container": {
        const action = args.action || "list";
        const containerNames = ["chest", "furnace", "barrel", "shulker", "hopper", "dropper", "dispenser", "blast_furnace", "smoker", "crafting_table", "brewing_stand", "bed", "storage", "crate", "cabinet", "cupboard", "drawer"];
        let containerBlock;
        if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
          const Vec3 = require("vec3");
          containerBlock = bot.blockAt(new Vec3(args.x, args.y, args.z));
          // 给了坐标就不检查名字了 直接尝试打开（mod箱子名字千奇百怪）
        } else {
          // 06-12改：原来只看脚边7个固定格,箱子在斜角/2格外就"附近没有容器"。改成半径4格立体扫描挑最近的
          const pos = bot.entity.position.floored();
          let best = null, bestD = Infinity;
          for (let sx = -4; sx <= 4; sx++) {
            for (let sy = -2; sy <= 3; sy++) {
              for (let sz = -4; sz <= 4; sz++) {
                const b = bot.blockAt(pos.offset(sx, sy, sz));
                if (!b) continue;
                const rn = ((stateIdCache[b.stateId] || b.name) || "").toLowerCase();
                if (!containerNames.some((n) => rn.includes(n))) continue;
                const d = sx * sx + sy * sy + sz * sz;
                if (d < bestD) { bestD = d; best = b; }
              }
            }
          }
          containerBlock = best;
        }
        if (!containerBlock) {
          return { content: [{ type: "text", text: "附近没有找到容器方块" }] };
        }
        try {
          // tp到箱子旁(07-06重写)：旧版 block.name==="air" 判空气——mod方块vanilla名常读成"air"实际实心，
          // 曾把y+2的墙里当安全位，tp进去闷死(19血→0)。统一走tpNearBlockSafe；没有安全位就【不tp】直接报错。
          const cpos = containerBlock.position;
          const dist = bot.entity.position.distanceTo(cpos);
          if (dist > 3) {
            const land = tpNearBlockSafe(cpos.x, cpos.y, cpos.z, "开箱");
            if (!land) {
              return { content: [{ type: "text", text: `箱子(${cpos.x},${cpos.y},${cpos.z})周围找不到安全落脚点(埋墙里/悬空/危险方块)，不硬tp了——把我带过去或换个箱子` }] };
            }
            await new Promise(r => setTimeout(r, 800)); // tp在服务器排队,多等一拍再看箱子
          }
          await bot.lookAt(cpos.offset(0.5, 0.5, 0.5));
          await new Promise(r => setTimeout(r, 200));
          // 开窗超时优化(07-06)：mineflayer默认20秒——箱子第一次开经常卡满20秒白等、第二次才成。
          // 改8秒超时+失败自动靠近重试一次(最多16秒，比旧的一次20秒还快)
          let window = null;
          for (let tryN = 0; tryN < 2 && !window; tryN++) {
            try {
              const opening = bot.openBlock(containerBlock);
              opening.catch(() => {}); // 8秒后才迟到的失败别变成unhandledRejection
              window = await Promise.race([
                opening,
                new Promise((_, rej) => setTimeout(() => rej(new Error("开窗8秒超时")), 8000)),
              ]);
            } catch (e) {
              if (tryN === 0) {
                log(`[open_container] 第一次开窗失败(${e.message})，重新对准重试`);
                try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
                try { await bot.lookAt(cpos.offset(0.5, 0.5, 0.5)); } catch {}
                await new Promise(r => setTimeout(r, 600));
              } else { throw e; }
            }
          }
          if (action === "list") {
            const items = window.containerItems();
            const itemList = items.map((i) => `${i.name}x${i.count}`).join(", ");
            window.close();
            return { content: [{ type: "text", text: `${containerBlock.name}里有: ${itemList || "空"}` }] };
          } else if (action === "deposit") {
            const invItem = bot.inventory.items().find((i) => i.name.includes(args.item));
            if (!invItem) { window.close(); return { content: [{ type: "text", text: `背包里没有${args.item}` }] }; }
            const amt = args.count || invItem.count;
            await window.deposit(invItem.type, null, amt);
            window.close();
            return { content: [{ type: "text", text: `放入了 ${invItem.name}x${amt}` }] };
          } else if (action === "withdraw") {
            // 06-12：精确名优先匹配(防"gold"同时命中gold_ingot/golden_pickaxe)；数量按全容器同名总数clamp
            const wanted = (args.item || "").toLowerCase();
            const cands = window.containerItems();
            const contItem = cands.find((i) => i.name === wanted) ||
                             cands.find((i) => i.name.includes(wanted)) ||
                             cands.find((i) => (i.displayName || "").toLowerCase().includes(wanted));
            if (!contItem) { window.close(); return { content: [{ type: "text", text: `容器里没有${args.item}。容器内: ${cands.map(i=>i.name).join(", ") || "空"}` }] }; }
            const total = cands.filter((i) => i.type === contItem.type).reduce((s, i) => s + i.count, 0);
            const amt = Math.min(args.count || total, total);
            try {
              await window.withdraw(contItem.type, null, amt);
            } catch (e) {
              window.close();
              return { content: [{ type: "text", text: `取${contItem.name}(id:${contItem.type})x${amt}失败: ${e.message}。容器里同名共${total}个` }] };
            }
            window.close();
            return { content: [{ type: "text", text: `取出了 ${contItem.name}x${amt}` }] };
          }
          window.close();
          return { content: [{ type: "text", text: "未知操作" }] };
        } catch (e) {
          return { content: [{ type: "text", text: `容器操作失败: ${e.message}` }] };
        }
      }

      case "connect": {
        const h = args.host || MC_HOST;
        const p = args.port || MC_PORT;
        createBot(h, p);
        return { content: [{ type: "text", text: `连接 ${h}:${p}...` }] };
      }

      case "disconnect": {
        if (bot) {
          try { stopFollow(); } catch {}
          try { bot.quit(); } catch {}
          bot = null;
          connected = false;
          log("Disconnected by user");
          return { content: [{ type: "text", text: "已断开MC连接" }] };
        }
        return { content: [{ type: "text", text: "本来就没连" }] };
      }

      case "debug_chat": {
        const wait = (args.seconds || 10) * 1000;
        const captured = [];
        const onRawPlayer = (data) => {
          captured.push(`[RAW playerChat] sender=${data.senderName} plain=${data.plainMessage}`);
        };
        const onRawSystem = (data) => {
          captured.push(`[RAW systemChat] pos=${data.positionId} msg=${data.formattedMessage?.substring(0, 80)}`);
        };
        const onMsgStr = (msg, pos) => {
          captured.push(`[messagestr] pos=${pos} text="${msg}"`);
        };
        const onMsg = (jsonMsg, pos, sender) => {
          captured.push(`[message] pos=${pos} sender=${sender} text="${jsonMsg.toString()}"`);
        };
        const onChat = (username, message) => {
          captured.push(`[chat] <${username}> ${message}`);
        };

        bot._client.on("playerChat", onRawPlayer);
        bot._client.on("systemChat", onRawSystem);
        bot.on("messagestr", onMsgStr);
        bot.on("message", onMsg);
        bot.on("chat", onChat);

        await new Promise((r) => setTimeout(r, wait));

        bot._client.off("playerChat", onRawPlayer);
        bot._client.off("systemChat", onRawSystem);
        bot.off("messagestr", onMsgStr);
        bot.off("message", onMsg);
        bot.off("chat", onChat);

        if (captured.length === 0) {
          return { content: [{ type: "text", text: `等了${wait/1000}秒，没有收到任何聊天事件。\n可能原因：\n1. 没人说话\n2. 协议层没收到playerChat/systemChat包\n3. bot连接有问题` }] };
        }
        return { content: [{ type: "text", text: `收到${captured.length}个事件:\n${captured.join("\n")}` }] };
      }

      case "learn_item": {
        const dict = loadItemDict();
        const key = args.internal_name;
        if (!dict[key]) dict[key] = {};
        if (typeof dict[key] === "string") dict[key] = { display_name: dict[key] };
        if (args.display_name) dict[key].display_name = args.display_name;
        if (args.usage) dict[key].usage = args.usage;
        if (args.how_to_use) dict[key].how_to_use = args.how_to_use;
        if (args.recipe) dict[key].recipe = args.recipe;
        saveItemDict(dict);
        const parts = [];
        if (dict[key].display_name) parts.push(dict[key].display_name);
        if (dict[key].usage) parts.push(`用途:${dict[key].usage}`);
        if (dict[key].how_to_use) parts.push(`用法:${dict[key].how_to_use}`);
        if (dict[key].recipe) parts.push(`合成:${dict[key].recipe}`);
        return { content: [{ type: "text", text: `记住了 ${key}: ${parts.join(" | ")}` }] };
      }

      case "item_info": {
        const dict = loadItemDict();
        const q = args.name.toLowerCase();
        let entry = null, matchKey = null;
        for (const [k, v] of Object.entries(dict)) {
          const info = typeof v === "string" ? { display_name: v } : v;
          if (k.toLowerCase().includes(q) || (info.display_name && info.display_name.includes(args.name))) {
            entry = info; matchKey = k; break;
          }
        }
        if (!entry) return { content: [{ type: "text", text: `字典里没有「${args.name}」的记录` }] };
        const lines = [`${matchKey}`];
        if (entry.display_name) lines.push(`名称: ${entry.display_name}`);
        if (entry.usage) lines.push(`用途: ${entry.usage}`);
        if (entry.how_to_use) lines.push(`用法: ${entry.how_to_use}`);
        if (entry.recipe) lines.push(`合成: ${entry.recipe}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "craft": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const itemName = args.item.toLowerCase();
        const count = args.count || 1;
        const doRecursive = args.recursive || false;

        // === 递归合成：分析依赖树，自底向上合成 ===
        if (doRecursive) {
          const _mcD = require("minecraft-data")(bot.version);
          const Recipe = require("prismarine-recipe")(bot.version).Recipe;
          const vIdToNm = {}; for (const [nm, it] of Object.entries(_mcD.itemsByName)) vIdToNm[it.id] = nm;

          // 优先用serverRecipes(服务器真实配方·含mod)，fallback到vanilla
          const getRecipe = (nm) => {
            // 1. serverRecipes: 有ingredients的crafting配方
            const srs = (serverRecipes[nm] || []).filter(r => r.type && r.type.includes("crafting") && r.ingredients && r.ingredients.length > 0);
            if (srs.length > 0) return { source: "server", data: srs[0] };
            // 2. vanilla fallback
            const vi = _mcD.itemsByName[nm]; if (!vi) return null;
            const recs = Recipe.find(vi.id, null).filter(r => r.inShape || r.ingredients);
            return recs.length > 0 ? { source: "vanilla", data: recs[0] } : null;
          };
          const extractIngredients = (rec) => {
            const need = {};
            if (rec.source === "server") {
              for (const ing of rec.data.ingredients) {
                const nm = ing.name;
                if (nm) need[nm] = (need[nm] || 0) + (ing.count || 1);
              }
            } else {
              const cells = Array.isArray(rec.data.inShape) ? rec.data.inShape.flat() : (rec.data.ingredients || []);
              for (const cell of cells) {
                if (cell == null || cell === -1) continue;
                const id = (typeof cell === "object") ? cell.id : cell;
                if (id != null && id !== -1) { const nm = vIdToNm[id]; if (nm) need[nm] = (need[nm] || 0) + 1; }
              }
            }
            return need;
          };
          const getResultCount = (rec) => {
            if (rec.source === "server") return rec.data.resultCount || 1;
            return rec.data.result?.count || 1;
          };
          const invHave = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((a, i) => a + i.count, 0);

          // 递归解析依赖树（优先用server配方·支持mod）
          // visited用Map累加需求量，解决共享子原料问题（箱子+木棍都需要木板）
          const resolve = (target, needed, plan = [], visited = new Map(), stack = new Set()) => {
            if (stack.has(target)) return plan; // 循环依赖防护
            if (visited.has(target)) {
              // 已在计划里→累加需求量，更新batch数
              const totalNeeded = visited.get(target) + needed;
              visited.set(target, totalNeeded);
              const existing = plan.find(s => s.item === target);
              if (existing) {
                const deficit = totalNeeded - invHave(target);
                if (deficit > 0) {
                  const newBatches = Math.ceil(deficit / existing.resultCount);
                  if (newBatches > existing.count) {
                    // 需要更多batch→补充子原料
                    const extraBatches = newBatches - existing.count;
                    existing.count = newBatches;
                    const ings = existing.ingredients;
                    stack.add(target);
                    for (const [ingName, perBatch] of Object.entries(ings)) resolve(ingName, perBatch * extraBatches, plan, visited, stack);
                    stack.delete(target);
                  }
                }
              }
              return plan;
            }
            visited.set(target, needed);
            const have = invHave(target);
            const deficit = needed - have;
            if (deficit <= 0) return plan;
            const rec = getRecipe(target);
            if (!rec) return plan; // 原材料，不能合成
            const resultCount = getResultCount(rec);
            const batches = Math.ceil(deficit / resultCount);
            const ings = extractIngredients(rec);
            stack.add(target);
            for (const [ingName, perBatch] of Object.entries(ings)) resolve(ingName, perBatch * batches, plan, visited, stack);
            stack.delete(target);
            plan.push({ item: target, count: batches, ingredients: ings, perBatch: 1, resultCount, recipeSource: rec.source });
            return plan;
          };

          const plan = resolve(itemName, count);
          if (plan.length === 0) {
            const have = invHave(itemName);
            if (have >= count) return { content: [{ type: "text", text: `背包里已有 ${itemName}x${have}，不需要合成` }] };
            return { content: [{ type: "text", text: `「${itemName}」没有找到可递归的配方` }] };
          }

          // 检查原材料是否足够
          const rawMissing = [];
          const simInv = {}; bot.inventory.items().forEach(i => { simInv[i.name] = (simInv[i.name]||0) + i.count; });
          for (const step of plan) {
            const rec = getRecipe(step.item);
            if (!rec) continue;
            const ings = extractIngredients(rec);
            for (const [nm, per] of Object.entries(ings)) {
              const need = per * step.count;
              const avail = simInv[nm] || 0;
              if (avail < need && !getRecipe(nm)) rawMissing.push(`${nm}: 需要${need} 有${avail}`);
            }
            simInv[step.item] = (simInv[step.item]||0) + step.count * step.resultCount;
            for (const [nm, per] of Object.entries(ings)) simInv[nm] = (simInv[nm]||0) - per * step.count;
          }

          const planDesc = plan.map(s => `${s.item}x${s.count * s.resultCount}`).join(" → ");
          if (rawMissing.length > 0) {
            return { content: [{ type: "text", text: `递归合成${itemName}x${count}需要:\n${planDesc}\n\n缺少原材料:\n${rawMissing.join("\n")}` }] };
          }

          // 执行合成计划（后台）
          (async () => {
            try {
              notifyClaude(`[MC] 递归合成计划: ${planDesc}`, { event: "craft_plan" });
              for (const step of plan) {
                log(`[craft-recursive] 合成 ${step.item}x${step.count}`);
                // 复用现有craft逻辑：构造内部调用
                const _bfR = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                // 根据recipeSource选路径：server配方直接走recipe-book，vanilla配方先试bot.craft
                let craftedOk = false;
                if (step.recipeSource !== "server") {
                  const vi = _mcD.itemsByName[step.item];
                  if (vi) {
                    const recs = bot.recipesFor(vi.id, null, 1, craftingTable);
                    if (recs && recs.length > 0) {
                      await bot.craft(recs[0], step.count, craftingTable);
                      craftedOk = true;
                    }
                  }
                }
                if (!craftedOk) {
                  const rbE = (serverRecipes[step.item] || []).filter(r => r.type.includes("crafting") && r.recipeId);
                  if (rbE.length > 0 && craftingTable) {
                    const { once: mfOnce } = require("mineflayer/lib/promise_utils");
                    try { stopFollow(); } catch {}
                    const tp = craftingTable.position;
                    try { await Promise.race([bot.pathfinder.goto(new goals.GoalNear(tp.x, tp.y, tp.z, 2)), new Promise((_, rej) => setTimeout(rej, 12000))]); } catch {}
                    try { bot.pathfinder.setGoal(null); } catch {}
                    try { await bot.lookAt(tp.offset(0.5, 0.5, 0.5)); } catch {}
                    await bot.activateBlock(craftingTable);
                    const [cw] = await mfOnce(bot, "windowOpen", 20000);
                    for (let ci = 0; ci < step.count; ci++) {
                      bot._client.write("craft_recipe_request", { windowId: cw.id, recipe: rbE[0].recipeId, makeAll: false });
                      await new Promise(r => setTimeout(r, 500));
                      if (cw.slots[0]) { try { await bot.clickWindow(0, 0, 1); } catch {} }
                      else break;
                      await new Promise(r => setTimeout(r, 100));
                    }
                    try { bot.closeWindow(cw); } catch {}
                  } else { notifyClaude(`[MC] 递归合成: ${step.item}没有可用配方`, { event: "craft_error" }); }
                }
                await new Promise(r => setTimeout(r, 500));
                const _afR = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                const made = (_afR[step.item]||0) - (_bfR[step.item]||0);
                log(`[craft-recursive] ${step.item}: 合成前${_bfR[step.item]||0} 合成后${_afR[step.item]||0} +${made}`);
              }
              notifyClaude(`[MC] 递归合成完成！目标: ${itemName}x${count}`, { event: "craft_done" });
            } catch (e) {
              notifyClaude(`[MC] 递归合成失败: ${e.message}`, { event: "craft_error" });
            }
          })();
          return { content: [{ type: "text", text: `递归合成 ${itemName}x${count}\n计划: ${planDesc}\n后台执行中...` }] };
        }

        // 用服务器registry查真实ID（不用vanilla mcData，mod服ID会重排）
        let serverItemId = null;
        for (const [id, regItem] of Object.entries(bot.registry.items)) {
          if (regItem.name === itemName) { serverItemId = parseInt(id); break; }
        }
        // 也检查itemIdCache（BlockInfo学到的映射）
        if (!serverItemId) {
          for (const [id, name] of Object.entries(itemIdCache)) {
            if (name === itemName || name === `minecraft:${itemName}`) { serverItemId = parseInt(id); break; }
          }
        }
        if (!serverItemId) {
          const mcData = require("minecraft-data")(bot.version);
          const item = mcData.itemsByName[itemName];
          if (item) serverItemId = item.id;
        }
        if (!serverItemId) {
          const matches = Object.keys(bot.registry.itemsByName || {}).filter(n => n.includes(itemName));
          return { content: [{ type: "text", text: `找不到物品「${itemName}」${matches.length > 0 ? `\n相似: ${matches.slice(0, 5).join(", ")}` : ""}` }] };
        }

        _craftDbg = 0;
        log(`[craft] ${itemName} → serverItemId=${serverItemId}`);

        // vanilla id（配方表按 vanilla id 索引，mod 服 serverItemId 跟它对不上）
        const _mcData = require("minecraft-data")(bot.version);
        const vanillaItem = _mcData.itemsByName[itemName];
        const vanillaId = vanillaItem ? vanillaItem.id : null;
        log(`[craft] vanillaId=${vanillaId}`);

        // 找工作台
        let craftingTable = null;
        const pos = bot.entity.position.floored();
        for (let dx = -4; dx <= 4; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dz = -4; dz <= 4; dz++) {
              const block = bot.blockAt(pos.offset(dx, dy, dz));
              if (block && (block.name === "crafting_table" || (stateIdCache[block.stateId] || "").includes("crafting_table"))) {
                craftingTable = block;
                break;
              }
            }
            if (craftingTable) break;
          }
          if (craftingTable) break;
        }

        // 方案A：直接用 serverItemId 查（vanilla 服或 id 恰好对得上时能成）
        // mod服通常走不到这(serverItemId≠vanillaId导致recipesFor返空)，但vanilla服可以
        let recipes = bot.recipesFor(serverItemId, null, 1, craftingTable);
        log(`[craft] recipesFor(${serverItemId}) = ${recipes ? recipes.length : 0} recipes`);
        if (recipes && recipes.length > 0) {
          // 需要工作台的配方也优先走recipe-book(如果有缓存)
          const _rbA = (serverRecipes[itemName] || []).filter(r => r.type.includes("crafting"));
          if (_rbA.length > 0 && recipes[0].requiresTable) {
            log(`[craft] 方案A也走recipe-book: ${_rbA[0].recipeId}`);
            // 跳过方案A的bot.craft，让下面方案B的recipe-book逻辑处理
          } else {
            const _bfA = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
            bot.craft(recipes[0], count, craftingTable).then(() => {
              setTimeout(() => {
                const _afA = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                const _ns = new Set([...Object.keys(_bfA), ...Object.keys(_afA)]);
                const _df = []; for (const n of _ns) { const d = (_afA[n]||0)-(_bfA[n]||0); if (d !== 0) _df.push(`${n}:${d>0?"+":""}${d}`); }
                const ds = _df.join(" ") || "无变化";
                if (_df.some(d => d.includes("-"))) notifyClaude(`[MC] 合成了 ${count}x ${itemName}！背包变化: ${ds}`, { event: "craft_done" });
                else notifyClaude(`[MC] 合成${itemName}可能失败: 背包${ds}（材料没减少=服务器没真执行）`, { event: "craft_maybe_failed" });
              }, 1000);
            }).catch(e => notifyClaude(`[MC] 合成失败: ${e.message}`, { event: "craft_error" }));
            return { content: [{ type: "text", text: `合成 ${count}x ${itemName} 中...` }] };
          }
        }

        // 方案B（mod服核心）：vanilla 配方表查到配方→把里面所有 vanilla id remap 成服务器 id→craft。
        // 因为配方表按 vanilla id 索引、料/结果也是 vanilla id，而背包/服务器用重排后的 id，全都要翻译。
        if (vanillaId != null) {
          let vRecipes = [];
          try { vRecipes = require("prismarine-recipe")(bot.version).Recipe.find(vanillaId, null); } catch (e) { log(`[craft] Recipe.find出错: ${e.message}`); }
          log(`[craft] vanilla Recipe.find(${vanillaId}) = ${vRecipes.length} 条`);
          if (vRecipes.length > 0) {
            // vanilla id → 名字 → 服务器 id。
            // 注意：registry.itemsByName 在这服上给的是错id(实测oak_planks给8)，扫 registry.items 才对(给38)。
            // 优先用背包里同名物品的真实 type(最可靠)，其次扫 registry.items。
            // _mcData.items 是按数组下标存的，items[23]≠id为23的物品！用 itemsByName 反建 id→名字 表才对。
            const vIdToName = {};
            for (const [name, it] of Object.entries(_mcData.itemsByName)) vIdToName[it.id] = name;
            const v2s = (vid) => {
              if (vid == null || vid === -1) return vid;
              const nm = vIdToName[vid];
              if (_craftDbg < 12) { _craftDbg++; log(`[craft] v2s ${vid}→nm=${nm}`); }
              if (!nm) return vid;
              const inv = bot.inventory.items().find((i) => i.name === nm);
              if (inv) return inv.type;
              for (const [id, r] of Object.entries(bot.registry.items)) if (r.name === nm) return parseInt(id);
              return vid;
            };
            // inShape 的格子是对象 {id,metadata,count}(不是裸id)，要翻译 cell.id；ingredients 也是 {id,...}
            const remap = (r) => {
              const c = JSON.parse(JSON.stringify(r));
              if (c.result) c.result.id = v2s(c.result.id);
              if (Array.isArray(c.ingredients)) c.ingredients.forEach((i) => { if (i && typeof i === "object") i.id = v2s(i.id); });
              if (Array.isArray(c.inShape)) c.inShape = c.inShape.map((row) => row.map((cell) => {
                if (cell == null || cell === -1) return cell;
                if (typeof cell === "object") { cell.id = v2s(cell.id); return cell; }
                return v2s(cell);
              }));
              if (Array.isArray(c.delta)) c.delta.forEach((d) => { if (d && typeof d === "object") d.id = v2s(d.id); });
              return c;
            };
            // 背包里(服务器id)真有料的那条配方优先
            const invCount = (sid) => bot.inventory.items().filter((i) => i.type === sid).reduce((a, i) => a + i.count, 0);
            const cellId = (cell) => (cell && typeof cell === "object") ? cell.id : cell;
            const canMake = (rec) => {
              const need = {};
              const src = Array.isArray(rec.inShape)
                ? rec.inShape.flat().map(cellId).filter((x) => x != null && x !== -1)
                : (rec.ingredients || []).map((i) => (i && typeof i === "object") ? i.id : i);
              src.forEach((id) => { need[id] = (need[id] || 0) + 1; });
              return Object.entries(need).every(([id, n]) => invCount(parseInt(id)) >= n);
            };
            const remapped = vRecipes.map(remap);
            const pick = remapped.find(canMake) || remapped[0];
            log(`[craft] remap后 result.id=${pick.result.id} 料齐=${canMake(pick)} 需工作台=${pick.requiresTable}`);
            if (pick.requiresTable && !craftingTable) {
              return { content: [{ type: "text", text: `「${itemName}」是3x3配方，附近没工作台。先放个工作台` }] };
            }
            // 优先方案：recipe-book协议(craft_recipe_request)
            // mod服工作台ScreenHandler(type=107)的slot布局≠vanilla(type=11)，bot.craft发的window_click的slot号
            // 在服务器端对不上→服务器静默拒绝→材料不消耗→结果是本地假更新。
            // craft_recipe_request 让服务器自己处理slot操作，完全绕过布局问题。
            let recipeBookEntries = serverRecipes[itemName] || [];
            // 只用crafting类配方（shaped/shapeless），排除smelting等
            let craftingRecipes = recipeBookEntries.filter(r =>
              r.type.includes("crafting_shaped") || r.type.includes("crafting_shapeless")
            );
            // fallback: 如果declare_recipes没收到或没匹配上，猜配方ID
            if (craftingRecipes.length === 0 && pick.requiresTable) {
              const guessedId = `minecraft:${itemName}`;
              log(`[craft] recipe-book缓存空，猜测配方ID: ${guessedId}`);
              craftingRecipes = [{ recipeId: guessedId, type: "minecraft:crafting_shaped" }];
            }
            const useRecipeBook = craftingRecipes.length > 0 && pick.requiresTable;
            log(`[craft] recipe-book: ${craftingRecipes.length} 条可用 (${craftingRecipes.map(r=>r.recipeId).join(",")}) useRecipeBook=${useRecipeBook}`);

            (async () => {
              try {
                // 要工作台的：先停follow(免得跟人走抢寻路)+走到台前+看着它，否则够不着开不了窗(windowOpen超时)
                if (pick.requiresTable && craftingTable) {
                  try { stopFollow(); } catch {}
                  const tp = craftingTable.position;
                  try {
                    await Promise.race([
                      bot.pathfinder.goto(new goals.GoalNear(tp.x, tp.y, tp.z, 2)),
                      new Promise((_, rej) => setTimeout(() => rej(new Error("到工作台超时")), 12000)),
                    ]);
                  } catch (e) { log(`[craft] 走向工作台: ${e.message}`); }
                  try { bot.pathfinder.setGoal(null); } catch {}
                  try { await bot.lookAt(tp.offset(0.5, 0.5, 0.5)); } catch {}
                }
                // [pktspy] 开包监控
                const _before = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                global.__pktSpy = true;
                log(`[pktspy] === craft ${itemName} 开始,背包快照: ${JSON.stringify(_before)} ===`);

                if (useRecipeBook) {
                  // ===== recipe-book 方案 =====
                  // 1. 打开工作台窗口
                  const { once: mfOnce } = require("mineflayer/lib/promise_utils");
                  await bot.activateBlock(craftingTable);
                  const [craftWindow] = await mfOnce(bot, "windowOpen", 20000);
                  log(`[craft-rb] 窗口打开: id=${craftWindow.id} type=${craftWindow.type} slots=${craftWindow.slots.length}`);

                  // 2. 循环 count 次合成
                  const recipeId = craftingRecipes[0].recipeId;
                  for (let ci = 0; ci < count; ci++) {
                    log(`[craft-rb] 第${ci+1}/${count}次 发 craft_recipe_request: windowId=${craftWindow.id} recipe=${recipeId}`);
                    // 发 craft_recipe_request 让服务器自动摆料
                    bot._client.write("craft_recipe_request", {
                      windowId: craftWindow.id,
                      recipe: recipeId,
                      makeAll: false
                    });
                    // 等服务器回 craft_recipe_response 或 set_slot(slot=0有东西)
                    // craft_recipe_response 确认配方已放好
                    try {
                      let _onResp = null;
                      await Promise.race([
                        new Promise((resolve) => {
                          _onResp = (p) => {
                            if (p.windowId === craftWindow.id) {
                              log(`[craft-rb] 收到 craft_recipe_response: recipe=${p.recipe}`);
                              bot._client.removeListener("craft_recipe_response", _onResp);
                              resolve();
                            }
                          };
                          bot._client.on("craft_recipe_response", _onResp);
                        }),
                        new Promise((_, rej) => setTimeout(() => {
                          if (_onResp) bot._client.removeListener("craft_recipe_response", _onResp);
                          rej(new Error("craft_recipe_response超时(5s)"));
                        }, 5000))
                      ]);
                    } catch (e) {
                      log(`[craft-rb] ${e.message}, 继续尝试取结果...`);
                    }
                    // 等 set_slot/window_items 同步slot内容（超时300ms也继续）
                    await new Promise(resolve => {
                      const timer = setTimeout(resolve, 300);
                      const onSlot = (p) => {
                        if (p.windowId === craftWindow.id && p.slot === 0) {
                          clearTimeout(timer);
                          bot._client.removeListener("set_slot", onSlot);
                          setTimeout(resolve, 50); // 再等50ms确保slot更新
                        }
                      };
                      const onItems = (p) => {
                        if (p.windowId === craftWindow.id) {
                          clearTimeout(timer);
                          bot._client.removeListener("window_items", onItems);
                          setTimeout(resolve, 50);
                        }
                      };
                      bot._client.on("set_slot", onSlot);
                      bot._client.on("window_items", onItems);
                      // 清理函数，防止listener泄漏
                      setTimeout(() => {
                        bot._client.removeListener("set_slot", onSlot);
                        bot._client.removeListener("window_items", onItems);
                      }, 500);
                    });

                    // 3. 从 slot 0 取走结果放到背包
                    // 用 shift-click(mode=1) 直接把结果移到背包。
                    // 注意：vanilla shift-click结果槽会循环取直到材料用完，但因为
                    // craft_recipe_request 只摆一次料，取一次后grid就空了，不会多取。
                    const resultItem = craftWindow.slots[0];
                    log(`[craft-rb] slot0: ${resultItem ? (resultItem.name||resultItem.type)+"x"+resultItem.count : "空"}`);
                    if (resultItem) {
                      try {
                        await bot.clickWindow(0, 0, 1); // shift+左键
                        log(`[craft-rb] shift-click slot0 完成`);
                      } catch (e) {
                        log(`[craft-rb] shift-click slot0 失败: ${e.message}, 尝试左键取+放`);
                        try {
                          await bot.clickWindow(0, 0, 0); // 左键取到手上
                          const emptySlot = craftWindow.firstEmptySlotRange(craftWindow.inventoryStart, craftWindow.inventoryEnd);
                          if (emptySlot != null) {
                            await bot.clickWindow(emptySlot, 0, 0); // 左键放下
                          }
                          log(`[craft-rb] 左键取放 slot0→${emptySlot} 完成`);
                        } catch (e2) { log(`[craft-rb] 左键取放也失败: ${e2.message}`); }
                      }
                    } else {
                      log(`[craft-rb] slot0空,配方可能不被服务器接受(${recipeId})或材料不足,中止循环`);
                      break;
                    }
                    // 小延迟给服务器同步
                    await new Promise(r => setTimeout(r, 100));
                  }

                  // 4. 关闭窗口
                  try { bot.closeWindow(craftWindow); } catch (e) {}
                  log(`[craft-rb] 窗口已关闭`);

                } else {
                  // ===== 旧方案 fallback: bot.craft =====
                  log(`[craft] fallback到bot.craft (非工作台配方或无recipe-book缓存)`);
                  await bot.craft(pick, count, craftingTable);
                }

                // 延迟检查背包变化（等服务器同步完）
                setTimeout(() => {
                  try {
                    const _after = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                    const _names = new Set([...Object.keys(_before), ...Object.keys(_after)]);
                    const _diff = [];
                    for (const n of _names) { const d = (_after[n]||0)-(_before[n]||0); if (d !== 0) _diff.push(`${n}:${d>0?"+":""}${d}`); }
                    const diffStr = _diff.join(" ") || "无变化";
                    log(`[pktspy] === craft ${itemName} 完,背包变化: ${diffStr} ===`);
                    // 判断是否真消耗了材料
                    const realSuccess = _diff.some(d => d.includes("-")); // 有材料减少=真消耗
                    if (realSuccess) {
                      notifyClaude(`[MC] 合成了 ${count}x ${itemName}！背包变化: ${diffStr}`, { event: "craft_done" });
                    } else {
                      notifyClaude(`[MC] 合成${itemName}可能失败: 背包${diffStr}（材料没减少=服务器没真执行）`, { event: "craft_maybe_failed" });
                    }
                  } catch (e) { notifyClaude(`[MC] 合成了 ${count}x ${itemName}（背包检查异常）`, { event: "craft_done" }); }
                  global.__pktSpy = false;
                }, 2000);
              } catch (e) {
                global.__pktSpy = false;
                notifyClaude(`[MC] 合成失败: ${e.message}`, { event: "craft_error" });
              }
            })();
            return { content: [{ type: "text", text: `合成 ${count}x ${itemName} 中...${useRecipeBook ? "(recipe-book协议)" : "(bot.craft fallback)"}` }] };
          }
        }

        // 最后兜底：mod-only物品走recipe-book直接路径（Method A跳过+Method B因vanillaId=null跳过时）
        const _rbFallback = (serverRecipes[itemName] || []).filter(r => r.type.includes("crafting"));
        if (_rbFallback.length > 0 && craftingTable) {
          log(`[craft] mod-only recipe-book兜底: ${_rbFallback[0].recipeId}`);
          (async () => {
            try {
              try { stopFollow(); } catch {}
              const tp = craftingTable.position;
              try { await Promise.race([bot.pathfinder.goto(new goals.GoalNear(tp.x, tp.y, tp.z, 2)), new Promise((_, rej) => setTimeout(() => rej(), 12000))]); } catch {}
              try { bot.pathfinder.setGoal(null); } catch {}
              try { await bot.lookAt(tp.offset(0.5, 0.5, 0.5)); } catch {}
              const _bfM = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
              const { once: mfOnce } = require("mineflayer/lib/promise_utils");
              await bot.activateBlock(craftingTable);
              const [cw] = await mfOnce(bot, "windowOpen", 20000);
              const rid = _rbFallback[0].recipeId;
              for (let ci = 0; ci < count; ci++) {
                bot._client.write("craft_recipe_request", { windowId: cw.id, recipe: rid, makeAll: false });
                await new Promise(r => setTimeout(r, 500));
                const rs = cw.slots[0];
                if (rs) { try { await bot.clickWindow(0, 0, 1); } catch {} }
                else { log(`[craft-mod] slot0空,中止`); break; }
                await new Promise(r => setTimeout(r, 100));
              }
              try { bot.closeWindow(cw); } catch {}
              setTimeout(() => {
                const _afM = bot.inventory.items().reduce((m, it) => { m[it.name] = (m[it.name]||0)+it.count; return m; }, {});
                const _ns = new Set([...Object.keys(_bfM), ...Object.keys(_afM)]);
                const _df = []; for (const n of _ns) { const d = (_afM[n]||0)-(_bfM[n]||0); if (d !== 0) _df.push(`${n}:${d>0?"+":""}${d}`); }
                const ds = _df.join(" ") || "无变化";
                if (_df.some(d => d.includes("-"))) notifyClaude(`[MC] 合成了 ${count}x ${itemName}！背包变化: ${ds}`, { event: "craft_done" });
                else notifyClaude(`[MC] 合成${itemName}可能失败: 背包${ds}`, { event: "craft_maybe_failed" });
              }, 1000);
            } catch (e) { notifyClaude(`[MC] 合成失败: ${e.message}`, { event: "craft_error" }); }
          })();
          return { content: [{ type: "text", text: `合成 ${count}x ${itemName} 中...(mod recipe-book兜底)` }] };
        }

        return { content: [{ type: "text", text: `没有「${itemName}」的配方（serverItemId=${serverItemId} vanillaId=${vanillaId}）${craftingTable ? "" : "\n（3x3配方需要工作台）"}` }] };
      }

      case "scan_blocks": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const range = Math.min(args.range || 5, 16);
        const filter = args.blockType ? args.blockType.toLowerCase() : null;
        const debug = args.debug || false;
        const pos = bot.entity.position.floored();
        const found = {};

        // 每次scan时重新读中转文件，实现热更新
        loadStateIdCache();

        for (let dx = -range; dx <= range; dx++) {
          for (let dy = -range; dy <= range; dy++) {
            for (let dz = -range; dz <= range; dz++) {
              const block = bot.blockAt(pos.offset(dx, dy, dz));
              if (!block || block.name === "air" || block.name === "cave_air" || block.name === "void_air") continue;
              // 中转翻译：优先用缓存的修正名，否则用mineflayer的名
              const realName = (block.stateId !== undefined && stateIdCache[block.stateId]) || block.name;
              if (filter && !realName.includes(filter)) continue;
              const key = realName;
              if (!found[key]) found[key] = [];
              if (found[key].length < 3) {
                const coordStr = `${pos.x+dx},${pos.y+dy},${pos.z+dz}`;
                found[key].push(debug ? `${coordStr}[sid:${block.stateId}]` : coordStr);
              } else if (found[key].length === 3) {
                found[key].push("...");
              }
            }
          }
        }

        const entries = Object.entries(found).sort((a, b) => a[0].localeCompare(b[0]));
        if (entries.length === 0) {
          return { content: [{ type: "text", text: filter ? `周围${range}格内没有找到 ${filter}` : `周围${range}格内没有方块（？）` }] };
        }
        const lines = entries.map(([name, positions]) => `${name}: ${positions.join(" / ")}`);
        return { content: [{ type: "text", text: `我的位置: ${pos.x},${pos.y},${pos.z}\n周围${range}格方块:\n${lines.join("\n")}` }] };
      }

      case "debug_log": {
        try {
          const content = fs.readFileSync(DEBUG_LOG, "utf8");
          const allLines = content.split("\n").filter(Boolean);
          const n = args.lines || 30;
          const recent = allLines.slice(-n);
          return { content: [{ type: "text", text: recent.join("\n") || "(空)" }] };
        } catch (e) {
          return { content: [{ type: "text", text: `读取日志失败: ${e.message}` }] };
        }
      }

      case "verify_block": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const bx = args.x, by = args.y, bz = args.z;
        const block = bot.blockAt(require("vec3")(bx, by, bz));
        const currentName = block ? block.name : "unknown";
        const sid = block ? block.stateId : "?";
        const realName = await learnBlockAt(bx, by, bz);
        if (realName) {
          const changed = currentName !== realName && !currentName.includes(realName.replace("minecraft:", ""));
          return { content: [{ type: "text", text: `${bx},${by},${bz}: ${realName} (stateId=${sid}${changed ? `, 之前显示为${currentName}，已修正` : "，映射正确"})` }] };
        }
        return { content: [{ type: "text", text: `${bx},${by},${bz}: 查询失败（/data命令没回应，bot可能没有op权限）当前显示: ${currentName} (stateId=${sid})` }] };
      }

      case "ultimine": {
        const act = args.action || "status";
        if (act === "on") {
          const ok = ultimineSetPressed(true);
          return { content: [{ type: "text", text: ok ? "连锁破坏已按住 ⚠️现在挖任何方块都会连锁(整条矿脉/整棵树)，别在建筑边上乱挖，用完记得 ultimine off。连锁吃饥饿，饿了连不动" : "发包失败，看debug_log" }] };
        }
        if (act === "off") {
          const ok = ultimineSetPressed(false);
          return { content: [{ type: "text", text: ok ? "连锁破坏已松开" : "发包失败，看debug_log" }] };
        }
        return { content: [{ type: "text", text: `连锁破坏: ${bot._ultiminePressed ? "按住中⚠️" : "没按"}（频道声明: ${bot._ultimineRegistered ? "已发" : "未发"}，首次on时自动发）` }] };
      }

      case "sneak": {
        const act = args.action || "status";
        if (act === "on") {
          bot._sneakLocked = true;
          // clearControlStates到处在被调(stopFollow/战斗收手/挖矿收尾/stop急停),会把sneak一起清掉——
          // patch一层:清完自动把sneak按回去。潜行是"姿态",不该被"动作收尾"顺手取消(深暗之域突然站起来=Warden听见)
          if (!bot._clearCSPatched) {
            bot._clearCSPatched = true;
            const origClear = bot.clearControlStates.bind(bot);
            bot.clearControlStates = () => {
              origClear();
              if (bot._sneakLocked) { try { bot.setControlState("sneak", true); } catch {} }
            };
          }
          try { bot.setControlState("sneak", true); } catch (e) {
            return { content: [{ type: "text", text: `潜行失败: ${e.message}` }] };
          }
          return { content: [{ type: "text", text: "已潜行(shift按住)。移动会变慢;stop不会解除,解除用 sneak off" }] };
        }
        if (act === "off") {
          bot._sneakLocked = false;
          try { bot.setControlState("sneak", false); } catch {}
          return { content: [{ type: "text", text: "已解除潜行" }] };
        }
        return { content: [{ type: "text", text: `潜行: ${bot._sneakLocked ? "开(按住中,动作收尾后自动保持)" : "关"}` }] };
      }

      case "viewer": {
        const act = args.action || "status";
        if (act === "on") {
          const r = startViewer();
          return { content: [{ type: "text", text: r.msg }] };
        }
        if (act === "off") {
          stopViewer(false);
          return { content: [{ type: "text", text: "viewer已关(端口3007已释放)" }] };
        }
        const up = !!(bot && bot.viewer && bot._viewerUp);
        let txt = up ? `viewer开着: http://localhost:${VIEWER_PORT}` : "viewer关着";
        if (!up && viewerWanted) txt += "(之前开过——重连自动恢复没成的话再 viewer on 一次)";
        return { content: [{ type: "text", text: txt }] };
      }

      case "trinket": {
        // ★★★ 配饰使用知识(2026-07-05实测，写给换模型后的下个session，别重新摸索) ★★★
        //  1. artifacts mod 的配饰(bunny_hoppers兔子跳鞋、pocket_piston口袋活塞等)【不是盔甲】，
        //     equip_armor 按名字认不出它们——这是正常的，不是 stateId/registry 映射坏了。
        //  2. 正确装配饰：直接 use_item <物品名>，Trinkets mod 会自动把它塞进【对应部位】的配饰槽。
        //     实测：bunny_hoppers 自动进 49 号(鞋子配饰槽)，pocket_piston 自动进 59 号槽。
        //  3. 手动 trinket put 到 45 号槽是【错的】——45 不一定是该物品对应部位的槽，优先 use_item 自动入槽。
        //  4. 本工具的 info(trinket info) 用来看 45~61 号扩展槽的占用状态；put/take 是兜底手动操作。
        // 配饰槽实验(06-13凌晨·薅羊毛时刻)：Trinkets这类mod把配饰槽挂在玩家背包窗口45号之后
        const win = bot.inventory;
        const total = win.slots.length;
        const act = args.action || "info";
        if (act === "info") {
          const extra = [];
          for (let i = 45; i < total; i++) {
            const s = win.slots[i];
            extra.push(`${i}:${s ? `${s.name}x${s.count}` : "空"}`);
          }
          const held = [];
          for (let i = 0; i < Math.min(total, 45); i++) {
            const s = win.slots[i];
            if (s) held.push(`${i}:${s.name}x${s.count}`);
          }
          return { content: [{ type: "text", text: `玩家窗口槽位总数${total}(原版46)。45号以后: ${extra.join(", ") || "没有扩展槽(配饰槽可能不在这个窗口)"}\n常规槽: ${held.slice(0, 20).join(", ")}` }] };
        }
        if (act === "put") {
          const item = bot.inventory.items().find((i) => i.name.includes(args.item));
          if (!item) return { content: [{ type: "text", text: `背包没有${args.item}(注意:副手/盔甲槽里的东西搜不到,先take出来)` }] };
          if (args.slot === undefined) return { content: [{ type: "text", text: "要slot号，先trinket info看" }] };
          const srcSlot = item.slot;
          // 窗口库认为玩家窗口只到45号,点46+直接抛invalid operation(00:52卡光标丢苹果两次的真凶)
          // 临时把窗口边界抬到实际槽数,点完恢复
          const _origEnd = win.inventoryEnd;
          try {
            if (args.slot > 45) win.inventoryEnd = total - 1;
            await bot.clickWindow(srcSlot, 0, 0); // 拿起
            await bot.clickWindow(args.slot, 0, 0); // 放进目标槽
            await new Promise((r) => setTimeout(r, 300));
            // 光标上若还有东西(槽位拒收被弹回)→放回原位,绝不留在光标上
            if (bot.inventory.selectedItem) { try { await bot.clickWindow(srcSlot, 0, 0); } catch {} }
            const after = bot.inventory.slots[args.slot];
            return { content: [{ type: "text", text: `槽${args.slot}现在: ${after ? `${after.name}x${after.count}` : "空(没放进去,这槽不收这物品)"}` }] };
          } catch (e) {
            // 出错也要抢救光标,别再把一摞苹果留在悬空态
            try { if (bot.inventory.selectedItem) await bot.clickWindow(srcSlot, 0, 0); } catch {}
            return { content: [{ type: "text", text: `操作失败: ${e.message}(光标已尝试放回)` }] };
          } finally {
            win.inventoryEnd = _origEnd;
          }
        }
        if (act === "take") {
          if (args.slot === undefined) return { content: [{ type: "text", text: "要slot号" }] };
          const _origEnd2 = win.inventoryEnd;
          try {
            const s = bot.inventory.slots[args.slot];
            if (!s) return { content: [{ type: "text", text: `槽${args.slot}本来就空` }] };
            if (args.slot > 45) win.inventoryEnd = total - 1; // 同put:46+槽要先抬窗口边界
            await bot.clickWindow(args.slot, 0, 1); // shift点回背包
            await new Promise((r) => setTimeout(r, 300));
            const after = bot.inventory.slots[args.slot];
            return { content: [{ type: "text", text: `槽${args.slot}现在: ${after ? `${after.name}x${after.count}` : "已取回背包"}` }] };
          } catch (e) {
            return { content: [{ type: "text", text: `操作失败: ${e.message}` }] };
          } finally {
            win.inventoryEnd = _origEnd2;
          }
        }
        return { content: [{ type: "text", text: "action要info/put/take" }] };
      }

      case "platform_check": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const pos = bot.entity.position;
        const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);
        const lines = [`我的位置: ${cx},${cy},${cz}`, "脚下3x3地面:"];
        for (let dx = -1; dx <= 1; dx++) {
          let row = "";
          for (let dz = -1; dz <= 1; dz++) {
            const block = bot.blockAt(require("vec3")(cx + dx, cy - 1, cz + dz));
            const name = block ? (stateIdCache[block.stateId] || block.name) : "void";
            const safe = block && block.name !== "air" && block.name !== "cave_air";
            row += safe ? `[${name.replace("minecraft:", "").substring(0, 8).padEnd(8)}]` : `[  AIR   ]`;
          }
          lines.push(row);
        }
        const headBlock = bot.blockAt(require("vec3")(cx, cy, cz));
        const feetBlock = bot.blockAt(require("vec3")(cx, cy + 1, cz));
        lines.push(`头部: ${headBlock ? headBlock.name : "void"} | 身体: ${feetBlock ? feetBlock.name : "void"}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "find_and_dig": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const targetType = args.blockType.replace("minecraft:", "");
        const wantCount = args.count || 10;
        const searchRange = args.range || 30;
        const maxTunnel = args.maxTunnel || 5;       // ②深度闸：要挖穿超过这么多格才够到的矿直接放弃
        const climbBack = args.climbBack !== false;  // ③挖完爬回原地(默认开)
        const useUltimine = args.ultimine === true;  // FTB Ultimine连锁破坏：每次挖前按住,挖完立刻松手(finally保证)
        const pos = bot.entity.position;
        const startY = Math.floor(pos.y);            // 记下出发高度，挖完pillar爬回
        if (currentTask) currentTask.interrupted = true;
        const myTask = { type: "find_and_dig", state: { targetType, wantCount, collected: 0 }, interrupted: false };
        currentTask = myTask;
        try { if (bot._digMovements) bot.pathfinder.setMovements(bot._digMovements); } catch {} // 挖矿用 canDig 版



        // 类别/前缀智能匹配(2026-05-30加): wood/木头→所有原木, oak→oak_log+oak_wood, 精确名→精确(向后兼容)
        // 07-06修：mod方块带命名空间(如wildernature:magnolia_log)，传"magnolia_log"也必须匹配上——
        // 昨晚魔纹木0/1根因之一：扫描81862格0候选直接break(和attack工具当初认不出species:limpet同族bug，
        // 07-05只修了attack侧，挖矿侧漏了)。去命名空间后再跑原有规则。
        const blockMatches = (name, target) => {
          name = (name || "").replace("minecraft:", "");
          target = (target || "").replace("minecraft:", "");
          const n = name.includes(":") ? name.split(":").pop() : name;
          const t = target.includes(":") ? target.split(":").pop() : target;
          if (name === target || n === t) return true;
          if (/^(wood|木头|原木|log|logs)$/.test(t)) return /(_|^)(log|wood)$/.test(n);
          if (/^(ore|矿|矿石)$/.test(t)) return /_ore$/.test(n);
          if (/^(leaves|树叶|叶子)$/.test(t)) return /_leaves$/.test(n);
          if (n === t + "_log" || n === t + "_wood") return true;
          return false;
        };

        (async () => {
          let collected = 0;
          const maxAttempts = Math.max(4, wantCount * 2); // 07-06:count=1时原来只有2次机会,寻路一超时就缴械→至少给4次
          const failedSpots = new Map(); // "x,y,z"→失败次数。同一颗连败2次拉黑,别对着算不出路的矿空转(05-31曾对一颗煤刷了1小时"Took to long")
          for (let attempt = 0; attempt < maxAttempts && collected < wantCount; attempt++) {
            if (myTask.interrupted) break;
            if (combatMode) {
              await new Promise(r => setTimeout(r, 1000));
              attempt--;
              continue;
            }
            // ①裸露矿优先 + ②深度闸：给每个候选打分，裸露(有空气面)的大幅优先，
            // 深埋的按要挖穿的隧道长度惩罚，超过 maxTunnel 直接跳过(不为一颗矿掏大坑)
            const here = bot.entity.position;
            const eye = here.offset(0, 1.62, 0);
            let found = null;
            let bestScore = Infinity;
            let bestExposed = 0;
            for (let dx = -searchRange; dx <= searchRange; dx++) {
              for (let dy = -16; dy <= 5; dy++) {
                for (let dz = -searchRange; dz <= searchRange; dz++) {
                  const bpos = _v3(Math.floor(here.x) + dx, Math.floor(here.y) + dy, Math.floor(here.z) + dz);
                  const block = bot.blockAt(bpos);
                  if (!block) continue;
                  const realName = (stateIdCache[block.stateId] || block.name).replace("minecraft:", "");
                  if (!blockMatches(realName, targetType)) continue;
                  if ((failedSpots.get(`${bpos.x},${bpos.y},${bpos.z}`) || 0) >= 2) continue; // 连败2次的拉黑
                  const dist = bpos.distanceTo(here);
                  const exposed = exposedFaces(bpos);
                  let score;
                  if (exposed > 0) {
                    // 裸露矿：基准减1000强力优先，越多空气面越好，再按距离
                    score = -1000 - exposed * 10 + dist;
                  } else {
                    // 埋着的：远到不可能在闸内的直接跳过，否则算隧道成本，超闸跳过
                    if (dist > maxTunnel + 3) continue;
                    const tcost = tunnelCost(eye, bpos.offset(0.5, 0.5, 0.5));
                    if (tcost > maxTunnel) continue; // ②深度闸
                    score = tcost * 8 + dist;
                  }
                  if (score < bestScore) { bestScore = score; found = bpos; bestExposed = exposed; }
                }
              }
            }
            if (!found) break;
            log(`[find_and_dig] 选中 ${found.x},${found.y},${found.z} exposed=${bestExposed} score=${bestScore.toFixed(0)}`);

            // 用 GoalGetToBlock 走到矿石【相邻可站位】——不是 GoalNear 的"直线2格内"
            // (GoalNear 隔着墙也判到达→bot 不动→bot.dig 隔空挖矿=虚空索敌)。
            // canDig 开着 pathfinder 会挖隧道真正接近被石头包裹的地下矿。
            const { GoalGetToBlock, GoalNear } = goals;
            let reached = true;
            try {
              try { bot.pathfinder.setGoal(null); } catch {}
              await Promise.race([
                bot.pathfinder.goto(new GoalGetToBlock(found.x, found.y, found.z)),
                new Promise((_, rej) => setTimeout(() => rej(new Error("寻路超时")), 25000)),
              ]);
            } catch (e) {
              log(`[find_and_dig] pathfinder到 ${found.x},${found.y},${found.z} 走不过去: ${e.message}`);
              try { bot.pathfinder.setGoal(null); } catch {}
              reached = false;
            }

            // ④垫脚：寻路够不到、但方块在头顶附近(浮空 oak_wood 那种)→走到正下方 pillar 上去
            if (!reached) {
              const me = bot.entity.position;
              const horiz = Math.hypot(found.x + 0.5 - me.x, found.z + 0.5 - me.z);
              if (found.y > me.y + 1 && horiz <= 4) {
                log(`[find_and_dig] 浮空方块够不到，尝试走到正下方垫脚 (高差${(found.y - me.y).toFixed(1)} 水平${horiz.toFixed(1)})`);
                try {
                  await Promise.race([
                    bot.pathfinder.goto(new goals.GoalNear(found.x, me.y, found.z, 1)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("到下方超时")), 12000)),
                  ]);
                } catch {}
                try { bot.pathfinder.setGoal(null); } catch {}
                const placed = await pillarUp(found.y - 1);
                log(`[find_and_dig] 垫了 ${placed} 格`);
                const eyeNow = bot.entity.position.offset(0, 1.62, 0);
                if (eyeNow.distanceTo(found.offset(0.5, 0.5, 0.5)) <= 4.5) reached = true;
              }
            }

            // ⑤tp兜底(2026-07-06·"0/1秒缴械"主修)：mod服pathfinder经常在thinkTimeout(2s)内算不出路,
            // 每颗矿"Took to long"2秒就放弃——follow/追击/撤退三件套全有tp兜底,唯独挖矿链没有,这里补齐。
            // 落点与战斗tp同一套安全检查(findSafeLanding:两格空气+脚下实心非危险非水):
            // 优先矿的四邻列(站矿旁边平视挖),兜底矿自己那列(站矿头顶朝下挖)。
            // 矿埋在实心深处周围全无落点→老实放弃这颗记failedSpots(tp进石头里=窒息,血泪教训不犯)。
            if (!reached && bot._findSafeLanding) {
              let land = null;
              for (const [cx, cz] of [[found.x + 1, found.z], [found.x - 1, found.z], [found.x, found.z + 1], [found.x, found.z - 1], [found.x, found.z]]) {
                land = bot._findSafeLanding(cx, found.y, cz);
                if (land) break;
              }
              if (land) {
                log(`[find_and_dig] pathfinder不行,tp兜底→(${land.x.toFixed(1)},${land.y},${land.z.toFixed(1)})`);
                safeChat(`/tp ${MC_USERNAME} ${land.x} ${land.y} ${land.z}`);
                for (let w = 0; w < 2 && !reached; w++) { // tp在服务器排队,分两拍确认到位
                  await new Promise((r) => setTimeout(r, w === 0 ? 1200 : 1800));
                  const eyeNow = bot.entity.position.offset(0, 1.62, 0);
                  if (eyeNow.distanceTo(found.offset(0.5, 0.5, 0.5)) <= 5) reached = true;
                }
                if (!reached) log(`[find_and_dig] tp兜底没到位(排队慢/被挡),这轮放弃`);
              } else {
                log(`[find_and_dig] tp兜底找不到安全落点(矿埋在实心里/周围危险),放弃这颗`);
              }
            }
            if (!reached) {
              const fk = `${found.x},${found.y},${found.z}`;
              failedSpots.set(fk, (failedSpots.get(fk) || 0) + 1);
            }

            if (reached) {
              try {
                const block = bot.blockAt(found);
                if (block && block.name !== "air" && block.name !== "cave_air") {
                  // 防隔空挖：必须真到矿跟前(reach内+看得见)，否则跳过不计数
                  const eyePos = bot.entity.position.offset(0, 1.62, 0);
                  const dist = eyePos.distanceTo(found.offset(0.5, 0.5, 0.5));
                  const canSee = typeof bot.canSeeBlock === "function" ? bot.canSeeBlock(block) : true;
                  if (dist > 5 || (dist > 2.5 && !canSee)) {
                    log(`[find_and_dig] 没真到矿跟前(dist=${dist.toFixed(1)} see=${canSee})→拒绝隔空挖 跳过`);
                  } else {
                    // 自动选工具：统一走pickToolByName(按名字猜kind+材质从好到差)
                    const tool = pickToolByName(block);
                    if (tool) {
                      try { await bot.equip(tool, "hand"); log(`[find_and_dig] 掏工具: ${tool.name}`); }
                      catch (e) { log(`[find_and_dig] 掏工具失败: ${e.message}`); }
                    } else { log(`[find_and_dig] 没合适工具,徒手挖 ${block.name}`); }
                    // ultimine窗口尽量短：只在真正dig那一下按住(dig自带forceLook,服务端ray-trace能对上起点)
                    if (useUltimine) ultimineSetPressed(true);
                    try {
                      await bot.dig(block);
                    } finally {
                      if (useUltimine) ultimineSetPressed(false);
                    }
                    collected++;
                    // 走过去捡掉落物——不然方块破坏了 掉落物在地上 背包还是空的
                    try {
                      await Promise.race([
                        bot.pathfinder.goto(new GoalNear(found.x, found.y, found.z, 1)),
                        new Promise((_, rej) => setTimeout(() => rej(new Error("捡取超时")), 8000)),
                      ]);
                    } catch {}
                    await new Promise((r) => setTimeout(r, 700));
                  }
                }
              } catch (e) {
                log(`[find_and_dig] dig error: ${e.message}`);
              }
            }
            await new Promise(r => setTimeout(r, 300));
          }
          // ③挖完爬回原地：如果挖矿过程下沉了(canDig 挖隧道下去)，pillar 填回竖井爬回出发高度，不留陷阱坑
          let climbed = 0;
          if (climbBack && !myTask.interrupted) {
            const dropped = startY - Math.floor(bot.entity.position.y);
            if (dropped >= 2) {
              log(`[find_and_dig] 挖完下沉了 ${dropped} 格，pillar 爬回 y=${startY}`);
              try { climbed = await pillarUp(startY); } catch (e) { log(`[pillar] 爬回出错: ${e.message}`); }
            }
          }
          if (currentTask === myTask) currentTask = null;
          // 收尾：清掉残留的 pathfinder 目标+移动状态，否则任务结束后 bot 会沿旧目标继续走+canDig边走边刨(莫名其妙乱跑)
          try { bot.pathfinder.setGoal(null); } catch {}
          try { bot.pathfinder.stop(); } catch {}
          try { bot.clearControlStates(); } catch {}
          const climbMsg = climbed > 0 ? `，爬回${climbed}格` : "";
          notifyClaude(`[MC] 挖完了！${collected}/${wantCount} 个 ${targetType}${climbMsg}`, { event: "dig_done" });
        })().catch(e => {
          if (currentTask === myTask) currentTask = null;
          try { bot.pathfinder.setGoal(null); } catch {}
          try { bot.pathfinder.stop(); } catch {}
          try { bot.clearControlStates(); } catch {}
          notifyClaude(`[MC] 挖矿出错: ${e.message}`, { event: "dig_error" });
        });

        return { content: [{ type: "text", text: `开始挖 ${wantCount} 个 ${targetType}（范围${searchRange}格），后台进行中` }] };
      }

      case "build": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const bx = args.x, by = args.y, bz = args.z;
        const w = args.width || 6, d = args.depth || 6, h = args.height || 4;
        const part = args.part || "all";
        const blockName = args.block || null;
        const vec3 = require("vec3");

        // 计算需要多少方块
        let needed = 0;
        if (part === "all" || part === "floor") needed += w * d;
        if (part === "all" || part === "walls") {
          for (let y = 1; y < h; y++) needed += 2 * w + 2 * (d - 2); // perimeter minus corners counted twice
          // 留一格门：减去2个方块(门口位置)
          needed -= 2;
        }
        if (part === "all" || part === "roof") needed += w * d;

        // 找背包里的建筑方块
        let buildItem = null;
        if (blockName) {
          buildItem = bot.inventory.items().find(i => i.name.includes(blockName));
        }
        if (!buildItem) {
          const buildable = ["cobblestone", "dirt", "stone", "oak_planks", "spruce_planks", "birch_planks", "planks", "cobbled_deepslate", "deepslate"];
          for (const bn of buildable) {
            buildItem = bot.inventory.items().find(i => i.name.includes(bn));
            if (buildItem) break;
          }
        }
        if (!buildItem) {
          return { content: [{ type: "text", text: `背包里没有建筑方块！需要约${needed}个。先用find_and_dig收集材料` }] };
        }

        const available = bot.inventory.items().filter(i => i.name === buildItem.name).reduce((s, i) => s + i.count, 0);
        log(`[build] 需要${needed}个${buildItem.name}, 背包有${available}个, 开始建造...`);
        if (currentTask) currentTask.interrupted = true;
        const myTask = { type: "build", state: { x: bx, y: by, z: bz, w, d, h, part }, interrupted: false };
        currentTask = myTask;

        // 后台建造（非阻塞）
        (async () => {
          await bot.equip(buildItem, "hand");
          let placed = 0;
          let outOfMaterial = false;

          async function placeAt(px, py, pz) {
            if (outOfMaterial || myTask.interrupted) return false;
            while (combatMode) { await new Promise(r => setTimeout(r, 1000)); }
            const existing = bot.blockAt(vec3(px, py, pz));
            if (existing && existing.name !== "air" && existing.name !== "cave_air") return true;

            const currentItem = bot.inventory.items().find(i => i.name === buildItem.name);
            if (!currentItem || currentItem.count <= 0) {
              outOfMaterial = true;
              return false;
            }

            try {
              safeChat(`/tp ${MC_USERNAME} ${px} ${py + 1} ${pz + 1}`);
              await new Promise(r => setTimeout(r, 400));

              const refPositions = [
                vec3(px, py - 1, pz),
                vec3(px - 1, py, pz), vec3(px + 1, py, pz),
                vec3(px, py, pz - 1), vec3(px, py, pz + 1),
              ];
              let refBlock = null;
              let faceVec = null;
              for (const rp of refPositions) {
                const rb = bot.blockAt(rp);
                if (rb && rb.name !== "air" && rb.name !== "cave_air") {
                  refBlock = rb;
                  faceVec = vec3(px - rp.x, py - rp.y, pz - rp.z);
                  break;
                }
              }

              if (refBlock) {
                await bot.equip(currentItem, "hand");
                await bot.placeBlock(refBlock, faceVec);
                placed++;
                await new Promise(r => setTimeout(r, 200));
                return true;
              } else {
                const scaffoldItem = bot.inventory.items().find(i => i.name.includes("dirt") || i.name.includes("cobblestone"));
                if (scaffoldItem) {
                  const groundRef = bot.blockAt(vec3(px, py - 2, pz));
                  if (groundRef && groundRef.name !== "air") {
                    await bot.equip(scaffoldItem, "hand");
                    await bot.placeBlock(groundRef, vec3(0, 1, 0));
                    await new Promise(r => setTimeout(r, 300));
                    const newRef = bot.blockAt(vec3(px, py - 1, pz));
                    if (newRef && newRef.name !== "air") {
                      await bot.equip(currentItem, "hand");
                      await bot.placeBlock(newRef, vec3(0, 1, 0));
                      placed++;
                      await new Promise(r => setTimeout(r, 200));
                      return true;
                    }
                  }
                }
                log(`[build] 无法在 ${px},${py},${pz} 放置：没有参考方块`);
                return false;
              }
            } catch (e) {
              log(`[build] place error at ${px},${py},${pz}: ${e.message}`);
              return false;
            }
          }

          if (part === "all" || part === "floor") {
            for (let x = 0; x < w; x++) {
              for (let z = 0; z < d; z++) {
                await placeAt(bx + x, by, bz + z);
              }
            }
          }
          if (part === "all" || part === "walls") {
            for (let y = 1; y < h; y++) {
              for (let x = 0; x < w; x++) {
                for (let z = 0; z < d; z++) {
                  const isWall = (x === 0 || x === w - 1 || z === 0 || z === d - 1);
                  const isDoor = (x === Math.floor(w / 2) && z === 0 && y <= 2);
                  if (isWall && !isDoor) {
                    await placeAt(bx + x, by + y, bz + z);
                  }
                }
              }
            }
          }
          if (part === "all" || part === "roof") {
            for (let x = 0; x < w; x++) {
              for (let z = 0; z < d; z++) {
                await placeAt(bx + x, by + h, bz + z);
              }
            }
          }

          const interrupted = myTask.interrupted;
          if (currentTask === myTask) currentTask = null;
          let msg = `[MC] 建造${outOfMaterial ? "中断(没材料)" : interrupted ? "被打断" : "完成"}！放了 ${placed}/${needed} 个 ${buildItem.name} (${w}x${d}x${h} ${part})`;
          if (outOfMaterial) {
            msg += ` 还缺${needed - placed}个`;
          }
          notifyClaude(msg, { event: "build_done" });
        })().catch(e => {
          if (currentTask === myTask) currentTask = null;
          notifyClaude(`[MC] 建造出错: ${e.message}`, { event: "build_error" });
        });

        return { content: [{ type: "text", text: `开始建造 ${w}x${d}x${h} ${part}（${buildItem.name}）！后台进行中，完成后通知你。需要约${needed}个方块，背包有${available}个` }] };
      }

      case "farm": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接" }] };
        const action = args.action || "auto";
        const searchRange = args.range || 15;
        const vec3 = require("vec3");
        const pos = bot.entity.position;
        if (currentTask) currentTask.interrupted = true;
        const myTask = { type: "farm", interrupted: false };
        currentTask = myTask;

        const maxAge = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3 };

        (async () => {
          let harvested = 0, planted = 0;

          if (action === "harvest" || action === "auto") {
            for (let dx = -searchRange; dx <= searchRange; dx++) {
              for (let dz = -searchRange; dz <= searchRange; dz++) {
                for (let dy = -2; dy <= 2; dy++) {
                  if (combatMode || myTask.interrupted) break;
                  const bpos = vec3(Math.floor(pos.x) + dx, Math.floor(pos.y) + dy, Math.floor(pos.z) + dz);
                  const block = bot.blockAt(bpos);
                  if (!block) continue;
                  const realName = (stateIdCache[block.stateId] || block.name).replace("minecraft:", "");
                  let isMature = false;
                  const age = block.getProperties ? block.getProperties().age : undefined;
                  if (age !== undefined) {
                    const max = maxAge[realName] || 7;
                    if (parseInt(age) >= max) isMature = true;
                  }
                  if (isMature) {
                    safeChat(`/tp ${MC_USERNAME} ${bpos.x} ${bpos.y + 1} ${bpos.z}`);
                    await new Promise(r => setTimeout(r, 400));
                    try {
                      const target = bot.blockAt(bpos);
                      if (target) { await bot.dig(target); harvested++; }
                    } catch (e) { log(`[farm] harvest error: ${e.message}`); }
                    await new Promise(r => setTimeout(r, 200));
                  }
                }
              }
            }
          }

          if (action === "plant" || action === "auto") {
            let seedItem = null;
            if (args.seed) seedItem = bot.inventory.items().find(i => i.name.includes(args.seed));
            if (!seedItem) {
              for (const sn of ["seeds", "carrot", "potato", "beetroot_seeds", "nether_wart"]) {
                seedItem = bot.inventory.items().find(i => i.name.includes(sn));
                if (seedItem) break;
              }
            }
            if (seedItem) {
              await bot.equip(seedItem, "hand");
              for (let dx = -searchRange; dx <= searchRange; dx++) {
                for (let dz = -searchRange; dz <= searchRange; dz++) {
                  for (let dy = -2; dy <= 2; dy++) {
                    if (combatMode || myTask.interrupted) break;
                    if (!seedItem || seedItem.count <= 0) {
                      seedItem = bot.inventory.items().find(i => i.name === seedItem.name);
                      if (!seedItem) break;
                      await bot.equip(seedItem, "hand");
                    }
                    const bpos = vec3(Math.floor(pos.x) + dx, Math.floor(pos.y) + dy, Math.floor(pos.z) + dz);
                    const block = bot.blockAt(bpos);
                    if (!block) continue;
                    const realName = (stateIdCache[block.stateId] || block.name).replace("minecraft:", "");
                    if (realName === "farmland" || block.name === "farmland") {
                      const above = bot.blockAt(bpos.offset(0, 1, 0));
                      if (above && (above.name === "air" || above.name === "cave_air")) {
                        safeChat(`/tp ${MC_USERNAME} ${bpos.x} ${bpos.y + 1} ${bpos.z + 1}`);
                        await new Promise(r => setTimeout(r, 400));
                        try {
                          const farmBlock = bot.blockAt(bpos);
                          if (farmBlock) { await bot.placeBlock(farmBlock, vec3(0, 1, 0)); planted++; }
                        } catch (e) { log(`[farm] plant error: ${e.message}`); }
                        await new Promise(r => setTimeout(r, 200));
                      }
                    }
                  }
                }
              }
            }
          }

          if (currentTask === myTask) currentTask = null;
          let msg = `[MC] 种地完成！`;
          if (harvested > 0) msg += ` 收割${harvested}个`;
          if (planted > 0) msg += ` 种了${planted}棵`;
          if (harvested === 0 && planted === 0) msg = "[MC] 没找到可收割的作物或可种植的耕地";
          notifyClaude(msg, { event: "farm_done" });
        })().catch(e => {
          if (currentTask === myTask) currentTask = null;
          notifyClaude(`[MC] 种地出错: ${e.message}`, { event: "farm_error" });
        });

        return { content: [{ type: "text", text: `开始种地（${action}模式，范围${searchRange}格），后台进行中` }] };
      }

      case "smelt": {
        if (!bot || !connected) return { content: [{ type: "text", text: "未连接MC" }] };
        const smeltAction = args.action || "start";
        const FURNACE_NAMES = ["furnace", "blast_furnace", "smoker"];
        const FUEL_PRIORITY = ["coal", "charcoal", "coal_block", "blaze_rod", "dried_kelp_block", "oak_planks", "spruce_planks", "birch_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "bamboo_planks", "stick", "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log"];

        // 找熔炉
        const findFurnace = () => {
          if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
            const Vec3 = require("vec3");
            return bot.blockAt(new Vec3(args.x, args.y, args.z));
          }
          const pos = bot.entity.position.floored();
          let best = null, bestD = Infinity;
          for (let sx = -6; sx <= 6; sx++) {
            for (let sy = -3; sy <= 3; sy++) {
              for (let sz = -6; sz <= 6; sz++) {
                const b = bot.blockAt(pos.offset(sx, sy, sz));
                if (!b) continue;
                const rn = ((stateIdCache[b.stateId] || b.name) || "").toLowerCase();
                if (!FURNACE_NAMES.some((n) => rn.includes(n))) continue;
                const d = sx * sx + sy * sy + sz * sz;
                if (d < bestD) { bestD = d; best = b; }
              }
            }
          }
          return best;
        };

        // tp到熔炉旁(07-06：统一走tpNearBlockSafe——旧版block.name判空气+y+2硬tp，和开箱同款闷死隐患)
        const goToFurnace = async (furnaceBlock) => {
          const cpos = furnaceBlock.position;
          const dist = bot.entity.position.distanceTo(cpos);
          if (dist > 3) {
            const land = tpNearBlockSafe(cpos.x, cpos.y, cpos.z, "熔炉");
            if (!land) throw new Error(`熔炉(${cpos.x},${cpos.y},${cpos.z})周围没有安全落脚点，不硬tp——把我带过去再操作`);
            await new Promise(r => setTimeout(r, 800));
          }
          await bot.lookAt(cpos.offset(0.5, 0.5, 0.5));
          await new Promise(r => setTimeout(r, 200));
        };

        // 自动选燃料
        const findFuel = () => {
          if (args.fuel) return bot.inventory.items().find(i => matchItem(i, args.fuel));
          for (const f of FUEL_PRIORITY) {
            const item = bot.inventory.items().find(i => i.name === f);
            if (item) return item;
          }
          return null;
        };

        // 物品匹配（兼容mod物品名）
        const matchItem = (item, query) => {
          const q = query.toLowerCase();
          return item.name.includes(q) || (itemIdCache[item.type] || "").toLowerCase().includes(q);
        };

        if (smeltAction === "list") {
          const pos = bot.entity.position.floored();
          const furnaces = [];
          for (let sx = -8; sx <= 8; sx++) {
            for (let sy = -3; sy <= 3; sy++) {
              for (let sz = -8; sz <= 8; sz++) {
                const b = bot.blockAt(pos.offset(sx, sy, sz));
                if (!b) continue;
                const rn = ((stateIdCache[b.stateId] || b.name) || "").toLowerCase();
                if (FURNACE_NAMES.some((n) => rn.includes(n))) furnaces.push(b);
              }
            }
          }
          if (!furnaces.length) return { content: [{ type: "text", text: "附近没有熔炉" }] };
          const results = [];
          for (const fb of furnaces.slice(0, 5)) {
            try {
              await goToFurnace(fb);
              const furnace = await bot.openFurnace(fb);
              await new Promise(r => setTimeout(r, 300));
              const inp = furnace.inputItem();
              const fue = furnace.fuelItem();
              const out = furnace.outputItem();
              results.push(`(${fb.position.x},${fb.position.y},${fb.position.z}) ${fb.name}: 原料=${inp ? inp.name + "x" + inp.count : "空"} 燃料=${fue ? fue.name + "x" + fue.count : "空"} 成品=${out ? out.name + "x" + out.count : "空"}`);
              furnace.close();
              await new Promise(r => setTimeout(r, 200));
            } catch (e) { results.push(`(${fb.position.x},${fb.position.y},${fb.position.z}) 打开失败: ${e.message}`); }
          }
          return { content: [{ type: "text", text: `附近${furnaces.length}个熔炉:\n${results.join("\n")}` }] };
        }

        const furnaceBlock = findFurnace();
        if (!furnaceBlock) return { content: [{ type: "text", text: "附近没有找到熔炉。先放一个或scan_blocks找一个" }] };

        try {
          await goToFurnace(furnaceBlock);
          const furnace = await bot.openFurnace(furnaceBlock);
          await new Promise(r => setTimeout(r, 300));

          if (smeltAction === "check") {
            const inp = furnace.inputItem();
            const fue = furnace.fuelItem();
            const out = furnace.outputItem();
            const p = furnaceBlock.position;
            const status = `熔炉(${p.x},${p.y},${p.z}):\n原料槽: ${inp ? inp.name + "x" + inp.count : "空"}\n燃料槽: ${fue ? fue.name + "x" + fue.count : "空"}\n成品槽: ${out ? out.name + "x" + out.count : "空"}\n${(furnace.fuel || 0) > 0 ? "正在燃烧" : "未燃烧"} | 进度: ${Math.round((furnace.progress || 0) * 100)}%`;
            furnace.close();
            return { content: [{ type: "text", text: status }] };
          }

          if (smeltAction === "collect") {
            const out = furnace.outputItem();
            if (!out) { furnace.close(); return { content: [{ type: "text", text: "成品槽是空的，还没炼好或已取走" }] }; }
            const outName = out.name;
            const outCount = out.count;
            await furnace.takeOutput();
            furnace.close();
            return { content: [{ type: "text", text: `取出了 ${outName}x${outCount}` }] };
          }

          if (smeltAction === "start") {
            if (!args.input) { furnace.close(); return { content: [{ type: "text", text: "需要指定input(要冶炼的物品名)" }] }; }
            const inputItem = bot.inventory.items().find(i => matchItem(i, args.input));
            if (!inputItem) { furnace.close(); return { content: [{ type: "text", text: `背包里没有${args.input}` }] }; }
            const fuelItem = findFuel();
            if (!fuelItem) { furnace.close(); return { content: [{ type: "text", text: "背包里没有燃料(coal/charcoal/planks/stick等)" }] }; }

            const smeltCount = Math.min(args.count || inputItem.count, inputItem.count);

            // 先取出旧成品（如果有）
            const oldOut = furnace.outputItem();
            if (oldOut) {
              try { await furnace.takeOutput(); } catch {}
              await new Promise(r => setTimeout(r, 200));
            }

            // 放原料
            await furnace.putInput(inputItem.type, null, smeltCount);
            await new Promise(r => setTimeout(r, 200));

            // 算需要多少燃料
            const fuelPer = /coal_block/.test(fuelItem.name) ? 80 : /coal|charcoal/.test(fuelItem.name) ? 8 : /log|plank/.test(fuelItem.name) ? 1.5 : /stick/.test(fuelItem.name) ? 0.5 : /blaze_rod/.test(fuelItem.name) ? 12 : /dried_kelp_block/.test(fuelItem.name) ? 20 : 1;
            const fuelNeeded = Math.min(Math.ceil(smeltCount / fuelPer), fuelItem.count);

            // 放燃料
            await furnace.putFuel(fuelItem.type, null, fuelNeeded);

            furnace.close();
            const secs = smeltCount * 10;
            const fp = furnaceBlock.position;
            const msg = `开始冶炼 ${inputItem.name}x${smeltCount}，燃料${fuelItem.name}x${fuelNeeded}。预计${secs}秒（${Math.ceil(secs/60)}分钟）。可以自由活动，完成后自动通知`;
            notifyClaude(`[MC] ${msg}`, { event: "smelt_started" });
            // 定时通知冶炼完成
            setTimeout(() => {
              notifyClaude(`[MC] 冶炼完成！${inputItem.name}x${smeltCount}已炼好，熔炉位置(${fp.x},${fp.y},${fp.z})。用smelt collect取成品`, { event: "smelt_done" });
            }, secs * 1000 + 2000);
            return { content: [{ type: "text", text: msg }] };
          }

          furnace.close();
          return { content: [{ type: "text", text: "未知smelt操作，支持: start/check/collect/list" }] };
        } catch (e) {
          return { content: [{ type: "text", text: `熔炉操作失败: ${e.message}` }] };
        }
      }

      default:
        return { content: [{ type: "text", text: `未知指令: ${name}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP server started, waiting for connect tool...");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
