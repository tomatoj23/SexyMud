# CODING_STANDARDS.md

> 评审（code-review Standards 轴）时读的 judgement 规则；实现期不必预载。机械可查的规则归 `scripts/` 门禁（content/docs/refs 三道，`corepack pnpm check`），此处只收工具查不了的那几条。每条末注出处教训。

## 注释不开「未来票号」支票

代码注释写**能力现状**：这半边是什么、谁在用、谁还没有。未来工作最多作历史注（「#53 已落历史腿」），**不写「实现随 #NN 到来」式承诺**——票号关了、支票没兑，注释就成了过期误导（教训：#53 复核 F-1，`terminalView.ts` setSuggestions 注释）。

## 测试基建可纯增量，断言不可动

「既有测试断言零改动」指 `.test.ts` 文件的断言；rig/helper（`panel-rig.ts` 等）允许**纯增量**扩展（加手势、加 helper）。边界：增量不得改变既有手势的可观察行为——既有测试原样全绿即是证明。新增断言一律开新文件或新 describe（教训：#53 panel-rig 增量手势的边界曾靠自行判断）。
