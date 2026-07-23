import readline from 'node:readline';

const behavior = process.argv[2] ?? 'success';

if (behavior !== 'never-ready') {
  process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
}

const input = readline.createInterface({ input: process.stdin });

input.on('line', (line) => {
  if (behavior !== 'success') {
    return;
  }

  const request = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      id: request.id,
      result: {
        speakers: [],
        segments: [],
        engineName: 'fake-worker'
      }
    })}\n`
  );
});
