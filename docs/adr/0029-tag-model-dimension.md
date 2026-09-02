# 标签模型：维度 + 键，两侧都住，与标记位分工

M2 结束后引擎有了实体与走/看/说，但标签仍是**桩**：`hasTag` 恒返回 `false`，`content/` 15 个文件零 tags，而 `schemas/` 里 tags 的形状已经**分裂成两种**（5 个集合是对象形态 `{维度键: string[]}`，`equipment` 的词缀是纯 `string[]`）。M3 开工前必须定四件事：标签的形状、它住在哪、它与已落地的标记位（`flags`）是什么关系、取值由谁把关。

## Context

spec/03 §5 只写了「标签 key + category，**不带值**」与「引擎维护 `(key, category)` 倒排索引」，**没定形状、没定宿主**。而事实是：

- `hasTag` facet 与 `has_tag` 谓词早已注册，只是 `subjectOf` 给的是桩实现（源码注释已把 tags 标给 M3）；`state/tree.ts` 预留了槽位——**接口在等数据，数据形状没定**。
- schema 已分裂，`content/` 零 tags，**取值合法性至今是约定不是门禁**。
- CONTEXT.md「归属」词条明确 _Avoid_: **category**，而 spec/03 §5 把标签的第二分量就叫 `category`。
- 已落地的 `flags`（状态树）已经扛着「执灯」这类运行时标记（look 票的合成遮蔽房），它与 tags 的边界没划清。

## Decision

### 1. 形状唯一：对象形态 `{ <维度>: [<键>…] }`，第二分量叫「维度」

一个维度可挂多个键；维度名与键的取值**都由 `content/config/dimensions.json` 封闭、由 schema 硬校验**——不在维度表里的维度写不进内容。`equipment` 的 `string[]` 孤例改齐。

定名依据不是发明：`dimensions.json` 的键**本来就是维度名**（`moveTag` 招式标签、`elementTag` 系别标签），`config.dimensions.schema.json` 把它们列为必填维度。叫 `dimension` 是把已有事实叫对，**键名一个都不动**。不用 `category` 是因为它与 CONTEXT.md 的禁用词撞。

### 2. 两侧都住，引擎只有一份实现

- **内容条目** → 注册表内建倒排索引 `byTag(dimension, key) → id[]`，覆盖**所有已加载集合中带 tags 的条目**（引擎不认识集合，只认带 tags 的条目）。
- **运行时实体** → `EntityState` 加 `tags` 槽（与 `flags` 并列），`subjectOf` 据此回答 `hasTag`。
- 「自身 ∪ 其内容条目」那条并集：**接缝先行 + 合成驱动**（M2-T4 先例）。今天世界里只有玩家是动态占用、而玩家没有内容条目，这一半**没有真实消费者**，等物化票（物品、有状态的 NPC）来缝合。

### 3. 内容条目侧也分 `tags` 与 `flags` 两层

与运行时侧对称。`spec/06` 的 `tags: ['quest']`（纯叙事道具 = 普通条目 + 这个标签 + 价值归零）改成 **`flags: ['quest']`**——它的真实语义是「这是不是任务道具」，一个**布尔判断**，不是归类。内容侧 `flags` 不进倒排索引（不可批量查询）。

### 4. 不取代标记位

`flags` 是**无维度、不可倒排**的裸布尔标记，回答「有没有」；`tags` 是**有维度、可倒排**的语义标记，回答「归在哪一类、能不能批量捞出来」。二者**并存且不互相取代**——look 票已用 `flags` 跑通（执灯可见），动它是纯返工。

### 5. 维度表随内容包走，由主机传入注册表

- **传了就硬校验，没传就跳过**；`byTag` 不依赖维度表（索引按 `(dimension, key)` 建，不需要知道哪些维度合法）。
- 维度表是**可选的能力**而非**必须的输入**——强制要求会让第三方包与测试无法最小装配（迷你包今天就没有 `config/`）。
- `element`（字段取值池，含 `none`）与 `elementTag`（标签维度，无 `none`）**不合并**：语义不同，合并会让「无属性」变成一个可挂的标签。防漂移的子集校验留 `content:check` 待办，M3 不做。

## Considered Options

- **纯 `string[]` 扁平 + 维度由表反查**：被否——`element` 与 `elementTag` 取值重叠（都含 `metal`/`wood`/…），键 → 维度的反查**有歧义**。
- **加一个缺省维度（如 `kind`）承接裸标签**：被否——任何不想归类的标签都会往里塞，维度表沦为杂物抽屉、失去约束意义；且 `tags: ['quest']` 的真实语义是布尔判断，归 `flags` 更准。
- **联合类型（`string[]` 或对象）**：被否——引擎要按形状分支，违反「内容即数据」的零分支要求，且 schema 无法干净表达。
- **第二分量沿用 `category`**：被否——与 CONTEXT.md「归属」词条的禁用词正撞。
- **标签取代标记位**：被否——语义不同（布尔 vs 归类），且 look 票已跑通，替换是纯返工。

## Consequences

- **13 个条目集合**的 schema 统一加 `tags`/`flags`（`config` 三类与 `condition` 除外）；schema 三处同步（`schemas/` + core 类型 + `docs/agents/content.md`）随每票执行。
- `equipment` 的 `string[]` 是唯一要改的既有形状。
- `spec/06` 与 `docs/agents/content.md` 里 `tags: ['quest']` 的表述要改成 `flags: ['quest']`。
- `hasTag` 从桩变真实现，`has_tag` 谓词第一次有真实数据可读。
- 迷你包要补一张**维度名完全不同**的 `config/dimensions.json`。
- **已知空缺**：并集那一半无真实消费者，只有合成测试行使。

规格落地位置：`docs/spec/03-world-model.md` §5.1、`docs/spec/06-content-schema.md`、`docs/agents/content.md`、`CONTEXT.md`（已增「维度」「标签」「标记位」词条）。
