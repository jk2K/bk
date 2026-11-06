import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export async function writeValidationReport(root: string, out: string, m: any) {
  const gap = await readFile(join(root, "docs/VALIDATION-GAPS.md"), "utf8");
  await writeFile(join(out, "REMAINING-WORK.md"), gap);
  const version = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version;
  const report = `# BK ${version} 验证报告

运行时间：${m.startedAt} 至 ${m.finishedAt}（UTC；北京时间加 8 小时）。

**结论：工程验证通过；完整 V1 验收尚未完成。**

## 检查结果

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| 自动测试 | ${m.counts.passed}/${m.counts.tests} 通过，${m.counts.failed} 失败，${m.counts.skipped} 跳过 | [逐项日志](logs/tests-spec.log) · [JUnit](junit.xml) · [TAP](logs/tests.tap) |
${m.checks
  .filter((c: any) => c.name !== "tests")
  .map(
    (c: any) =>
      "| " +
      c.name +
      " | 退出码 " +
      c.exitCode +
      "，" +
      c.durationMs +
      " ms | [日志](" +
      c.log +
      ") |",
  )
  .join("\n")}

## 可复查的场景

1. **真实 Git 流程**：首次来源生成提案；在隔离测试仓库模拟人工合并；来源不变时无新增模型调用；修改一条释放条件后只形成该规则与其索引的补丁；未审核版本未改正式工作树。[执行结果](pipeline-results.json) · [实际补丁](knowledge-proposal.patch)。此场景使用确定性的模型替身，不代表真实 Claude 语义判断已验证。
2. **真实 Chromium 流程**：展开折叠条款并断言可提取；在新导航中回放 Recipe 并比较正文；通过 BK 请求策略阻断 POST，断言服务器收到 0 次写请求。此录屏没有调用模型。

Codex SDK 公开数据集的评分器自检结果见 [JSON](codex-eval-self-test.json)。自检使用标准答案验证评分链路，实际模型分数需要单独运行评测。

3. **独立进程故障恢复**：采集、分析和提交阶段分别发送 SIGKILL，另停启真实 Git TCP 端点验证网络故障。提交中断发生在实际 Git push 和模拟审核创建之后。恢复后检查仅有一个已处理事件、一个提案分支和一次模拟审核创建。watch 多次轮询并推进排除文件变更后的游标。[故障注入结果](e2e-recovery.json)

## 截图与视频

[真实浏览器录屏（MP4）](browser-validation.mp4) · [实际 Recipe](browser-recipe.json)

| 截图 | 对应断言 |
| --- | --- |
| [展开前](01-source-collapsed.png) | 隐藏释放条件尚未进入可见正文 |
| [展开后](02-source-expanded.png) | 读取到了释放条件 |
| [请求保护](03-write-protection.png) | POST 被阻断，服务器写请求为 0 |

![真实浏览器写请求保护](03-write-protection.png)

画面为合成的本地 Wiki 来源页，不是 BK Web UI，不是生产业务系统，也不是真实 Claude 自主操作的录屏。视频由浏览器 CDP 实际帧按采集时间编码，非生成图片或结果示意图。截图只能证明对应可视状态，不能单独证明全部测试通过。

## 环境与代码追溯

Node：${m.node}；Chromium：${m.browserVersion}；视口：1280×720。

[运行元数据与源码 SHA-256](manifest.json) 记录基础 checkout、未提交增量、完整命令、耗时及逐文件指纹。本地验证包含同批提交的证据生成脚本及请求策略导出改动，因此不把基础 checkout SHA 单独描述为全部被测代码。后续 CI 在对应提交上生成同类证据。

[SHA256SUMS](SHA256SUMS) 可用于校验报告、日志、截图、视频、元数据和补丁的完整性。

## 尚未证明

真实企业模型认证与业务语义质量、多模态准确率、企业 SSO、三类 Git 平台的实际审核闭环及完整真实故障注入仍需验证。工程测试中的替身结果不能作为这些事项的通过证明。详见 [剩余工作与验收门槛](REMAINING-WORK.md)。

## 复跑方式

要求 Node 24+、Git、Chromium 和 ffmpeg。先执行 npm ci、npx playwright install --with-deps chromium，再执行 npm run validate:artifacts。

默认产物在 .bk/validation/latest/；BK_VALIDATION_DIR 可指定输出目录；已有浏览器可用 BK_CHROMIUM_EXECUTABLE_PATH 指定可执行文件。CI 自动执行并将同类证据上传为 Artifact，保留 30 天。仓库中的基线证据随 Git 长期保存。
`;
  await writeFile(join(out, "REPORT.md"), report);
  const hashes: Record<string, string> = {};
  async function walk(dir: string) {
    for (const e of await readdir(join(out, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p !== "SHA256SUMS")
        hashes[p] = createHash("sha256")
          .update(await readFile(join(out, p)))
          .digest("hex");
    }
  }
  await walk("");
  await writeFile(
    join(out, "SHA256SUMS"),
    Object.entries(hashes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, h]) => h + "  " + p)
      .join("\n") + "\n",
  );
}
