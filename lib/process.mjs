import { spawn } from 'node:child_process';

export function run(binary, args, { cwd, signal, timeout = 600_000, stderrLimit = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', stderrTruncated = false, finished = false;
    const child = spawn(binary, args, { cwd, signal, windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Die Verarbeitung hat das Zeitlimit erreicht.'));
    }, timeout);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-400_000); });
    child.stderr.on('data', data => { const next = stderr + data; stderrTruncated ||= next.length > stderrLimit; stderr = next.slice(-stderrLimit); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (signal?.aborted) return finish(new DOMException('Abgebrochen', 'AbortError'));
      if (code !== 0) return finish(new Error(`${binary} fehlgeschlagen (${code}): ${stderr.slice(-2200)}`));
      finish(null, { stdout, stderr, stderrTruncated });
    });
  });
}
