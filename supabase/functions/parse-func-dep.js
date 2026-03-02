import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const parseDependencies = (entryFile) => {
  const root = process.cwd();
  const entryPath = path.resolve(root, entryFile);
  const visited = new Set();
  
  const check = p => fs.existsSync(p) && fs.statSync(p).isFile();
  const resolve = (p, base) => {
    const target = path.resolve(base, p);
    const exts = ['', '.ts', '.js', '.tsx', '.jsx'];
    return exts.map(e => target + e).find(check) || 
      (fs.existsSync(target) && fs.statSync(target).isDirectory() && exts.slice(1).map(e => path.join(target, `index${e}`)).find(check));
  };

  const collect = (file) => {
    if (!file.startsWith(root) || visited.has(file) || !check(file)) return;
    visited.add(file);
    try {
      const matches = fs.readFileSync(file, 'utf-8')
        .matchAll(/(?:import\s+.*?\s+from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g);
      for (const m of matches) {
        const res = resolve(m[1], path.dirname(file));
        if (res) collect(res);
      }
    } catch {}
  };

  collect(entryPath);
  return [...visited].map(p => path.relative(path.dirname(entryPath), p)).sort();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(parseDependencies(process.argv[2] || 'afunc1/index.ts'), null, 2));
}

export { parseDependencies };
