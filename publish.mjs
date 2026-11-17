#!/usr/bin/env node
/**
 * 发布门禁 + 暂存发布（维护者用）。
 *
 * 为什么需要暂存目录：仓库里的 package.json 带着开发期脚本（`prepublishOnly` 会拒绝就地
 * 发布）；`npm publish <dir>` 只认暂存目录里的清单，所以把发布面字段挑出来重写一份，
 * 仓库清单一个字节都不动。
 *
 * 门禁（每次发布都跑，`--check` 只跑到门禁为止）。这里每一条都对应过一次真实缺陷或
 * 可预见的事故：
 * - `repository`/`bugs` 必须指向公开 org 仓：私有 monorepo 的 URL 匿名访问 404，
 *   而 npm provenance 还要求发布源与 `repository` 一致；
 * - `server.json` 的 `version` 必须跟 package.json 一致：Registry 与 npm 漂移后，
 *   客户端拿到的 remote 元数据会说错版本；
 * - `server.json` 的 remote 必须还是匿名端点：把账号面 URL 写进免费包的清单，
 *   会让 Registry 访客按「无认证」去调 `/v1/mcp`，首次调用就 401；
 * - `bin` 指向的文件必须存在且带 shebang：npm 会把 bin 链接成可执行文件，缺 shebang
 *   在直跑时报 `Exec format error`。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const passthrough = args.filter((arg) => arg !== "--check");
const dryRun = passthrough.includes("--dry-run");

/** 公开发布仓与 Registry 身份：改这里必须同步改 mirror 脚本与 docs/operations/public-distribution.md。 */
const PUBLIC_REPO = "visdenda/mcp-free-bridge";
const SERVER_NAME = "com.visdenda/free";
const REMOTE_URL = "https://visdenda.com/v1/mcp/free";
const PUBLISH_FILES = ["bin.mjs", "README.md", "LICENSE", "server.json"];

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(
  source.repository?.url === `git+https://github.com/${PUBLIC_REPO}.git`,
  `package.json repository.url must be git+https://github.com/${PUBLIC_REPO}.git (got ${source.repository?.url})`,
);
expect(
  source.bugs?.url === `https://github.com/${PUBLIC_REPO}/issues`,
  `package.json bugs.url must be https://github.com/${PUBLIC_REPO}/issues (got ${source.bugs?.url})`,
);
expect(
  server.repository?.url === `https://github.com/${PUBLIC_REPO}`,
  `server.json repository.url must be https://github.com/${PUBLIC_REPO} (got ${server.repository?.url})`,
);
expect(server.name === SERVER_NAME, `server.json name must be ${SERVER_NAME} (got ${server.name})`);
expect(
  server.version === source.version,
  `server.json version ${server.version} must equal package.json version ${source.version}`,
);
expect(
  Array.isArray(server.remotes) && server.remotes.length === 1,
  "server.json must have one remote",
);
expect(
  server.remotes?.[0]?.type === "streamable-http" && server.remotes?.[0]?.url === REMOTE_URL,
  `server.json remote must be streamable-http ${REMOTE_URL} (got ${JSON.stringify(server.remotes?.[0])})`,
);

for (const file of PUBLISH_FILES) {
  expect(existsSync(join(root, file)), `missing publish file: ${file}`);
}
const binPath = typeof source.bin === "object" ? Object.values(source.bin)[0] : undefined;
expect(typeof binPath === "string", "package.json bin must map a command to a file");
if (typeof binPath === "string") {
  const binFile = join(root, binPath.replace(/^\.\//, ""));
  expect(existsSync(binFile), `bin target does not exist: ${binPath}`);
  if (existsSync(binFile)) {
    expect(
      readFileSync(binFile, "utf8").startsWith("#!/usr/bin/env node"),
      `bin target must start with a node shebang: ${binPath}`,
    );
  }
}

if (failures.length > 0) {
  console.error("[mcp-free-bridge] publish gate failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "mcp-free-bridge-publish-"));
for (const file of PUBLISH_FILES) {
  cpSync(join(root, file), join(stage, file));
}

/** 只保留发布面字段；scripts/devDependencies/prepublishOnly 一律不进 stage。 */
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: source.license,
  keywords: source.keywords,
  homepage: source.homepage,
  repository: source.repository,
  bugs: source.bugs,
  type: source.type,
  bin: source.bin,
  files: source.files,
  publishConfig: source.publishConfig,
  engines: source.engines,
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (checkOnly || dryRun) {
  console.log(`[mcp-free-bridge] stage: ${stage}`);
  console.log(`[mcp-free-bridge] files: ${PUBLISH_FILES.join(", ")}`);
}
if (checkOnly) {
  rmSync(stage, { recursive: true, force: true });
  console.log("[mcp-free-bridge] check-only: all gates passed");
  process.exit(0);
}

// 供应链：CI 里显式打开（需要 id-token: write 与公开仓）；本地默认关，避免无 OIDC 直接失败。
const provenance = !dryRun && process.env.MCP_FREE_BRIDGE_PROVENANCE === "true";
if (provenance) console.log("[mcp-free-bridge] npm provenance enabled");

execFileSync(
  "npm",
  ["publish", stage, "--access", "public", ...(provenance ? ["--provenance"] : []), ...passthrough],
  { cwd: root, stdio: "inherit" },
);
