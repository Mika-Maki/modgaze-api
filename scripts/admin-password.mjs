import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AdminAuth, assertPassword, generatePassword } from '../src/admin-auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let authPath = resolve(root, 'config/admin-auth.private.json');
let mode = 'reset';
let assumeYes = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--auth' && args[index + 1]) authPath = resolve(args[++index]);
  else if (arg === '--status') mode = 'status';
  else if (arg === '--generate') mode = 'generate';
  else if (arg === '--remove') mode = 'remove';
  else if (arg === '--yes' || arg === '-y') assumeYes = true;
  else if (arg === '--help' || arg === '-h') mode = 'help';
  else { console.error('未知参数：' + arg); process.exit(2); }
}

function readAllStdin() {
  return new Promise((resolveInput, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.once('end', () => resolveInput(Buffer.concat(chunks).toString('utf8')));
    process.stdin.once('error', reject);
    process.stdin.resume();
  });
}
let pipedLines = null;
async function nextPipedLine() {
  if (pipedLines === null) pipedLines = (await readAllStdin()).split(/\r?\n/);
  return pipedLines.shift() ?? '';
}
function readHidden(prompt) {
  if (!process.stdin.isTTY) return nextPipedLine();
  return new Promise((resolveInput, reject) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') { cleanup(); process.stdout.write('\n'); reject(new Error('已取消')); return; }
        if (character === '\r' || character === '\n') { cleanup(); process.stdout.write('\n'); resolveInput(value); return; }
        if (character === '\u007f' || character === '\b') {
          if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (character >= ' ') { value += character; process.stdout.write('*'); }
      }
    };
    process.stdin.on('data', onData);
  });
}

function help() {
  console.log('Usage: npm run admin:password -- [options]');
  console.log('');
  console.log('  (no options)     交互式设置新密码');
  console.log('  --status         查看密码文件状态（不显示哈希）');
  console.log('  --generate       生成随机密码并写入哈希，明文只打印一次');
  console.log('  --remove --yes   删除密码文件，下次打开 WebUI 重新初始化');
  console.log('  --auth PATH      指定密码文件路径');
}

try {
  const auth = new AdminAuth(authPath);
  if (mode === 'help') {
    help();
  } else if (mode === 'status') {
    const status = await auth.status();
    console.log(JSON.stringify({ configured: status.configured, algorithm: status.algorithm ?? null, updatedAt: status.updatedAt ?? null, path: authPath }));
  } else if (mode === 'generate') {
    const password = generatePassword();
    await auth.setPassword(password);
    console.log('管理员密码已生成。请立即保存，以下明文只显示一次：');
    console.log(password);
    console.log('已有 WebUI 会话会在下一次请求时失效。');
  } else if (mode === 'remove') {
    if (!assumeYes && !process.stdin.isTTY) throw new Error('非交互模式删除密码文件必须加 --yes');
    if (!assumeYes) {
      const answer = await readHidden('确认删除管理员密码文件？下次打开 WebUI 将重新初始化（输入 YES）：');
      if (answer.trim() !== 'YES') throw new Error('已取消');
    }
    await auth.remove();
    console.log('管理员密码文件已删除；下次打开 WebUI 会进入首次初始化。');
  } else {
    const first = await readHidden('设置新的管理员密码（至少 10 位）：');
    assertPassword(first);
    const second = await readHidden('再输入一次：');
    if (first !== second) throw new Error('两次输入的密码不一致');
    await auth.setPassword(first);
    console.log('管理员密码已更新。WebUI 旧会话会在下一次请求时失效，请重新登录。');
  }
} catch (error) {
  console.error('操作失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
