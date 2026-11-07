// 无 UI 全流程：切题 → 批改 → 出图
const fs = require('fs');
const { runPipeline } = require('./core/pipeline');

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf('--' + k);
    return i >= 0 ? args[i + 1] : d;
  };
  const image = get('image', '/tmp/exam1.jpg');
  const out = get('out', '/tmp/graded.png');
  const t0 = Date.now();

  const { results } = await runPipeline({
    imagePath: image,
    outPath: out,
    onStage: s => console.log('  ' + s.label + (s.total ? `（${s.done}/${s.total}）` : '')),
  });

  fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(results, null, 2));
  console.log(`完成 → ${out}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
