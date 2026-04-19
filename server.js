const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');

const defaultStateData = {
  students: [],
  transactions: [],
  shortcuts: {
    earnReasons: [
      { id: '1', name: '按时完成作业', points: 1 },
      { id: '2', name: '按时完成作业', points: 2 },
      { id: '3', name: '按时完成作业', points: 3 },
      { id: '4', name: '上课积极表现', points: 1 },
      { id: '5', name: '上课积极表现', points: 2 },
      { id: '6', name: '上课积极表现', points: 3 },
      { id: '7', name: '测试成绩表现', points: 1 },
      { id: '8', name: '测试成绩表现', points: 2 },
      { id: '9', name: '测试成绩表现', points: 3 },
      { id: '10', name: '介绍同学上课', points: 10 },
      { id: '11', name: '积分兑换', points: -50 },
      { id: '12', name: '破坏公共设施', points: -10 },
      { id: '13', name: '扰乱课堂纪律', points: -1 }
    ],
    useReasons: [
      { id: '1', name: '换取小熊饼干', points: 5 },
      { id: '2', name: '换取铅笔', points: 3 },
      { id: '3', name: '换取笔记本', points: 8 },
      { id: '4', name: '换取橡皮擦', points: 2 },
      { id: '5', name: '换取小礼品', points: 15 },
      { id: '6', name: '抵扣作业', points: 10 }
    ]
  },
  cardTags: {},
  checkInRecords: []
};

function normalizeStateData(data) {
  const incoming = data && typeof data === 'object' ? data : {};
  const shortcuts = incoming.shortcuts && typeof incoming.shortcuts === 'object'
    ? incoming.shortcuts
    : {};

  return {
    students: Array.isArray(incoming.students) ? incoming.students : [],
    transactions: Array.isArray(incoming.transactions) ? incoming.transactions : [],
    shortcuts: {
      earnReasons: Array.isArray(shortcuts.earnReasons)
        ? shortcuts.earnReasons
        : defaultStateData.shortcuts.earnReasons,
      useReasons: Array.isArray(shortcuts.useReasons)
        ? shortcuts.useReasons
        : defaultStateData.shortcuts.useReasons
    },
    cardTags: incoming.cardTags && typeof incoming.cardTags === 'object' ? incoming.cardTags : {},
    checkInRecords: Array.isArray(incoming.checkInRecords) ? incoming.checkInRecords : []
  };
}

async function ensureStateFile() {
  await fsp.mkdir(dataDir, { recursive: true });
  if (fs.existsSync(stateFile)) {
    return;
  }

  const initialState = {
    version: 0,
    updatedAt: new Date().toISOString(),
    data: defaultStateData
  };
  await fsp.writeFile(stateFile, JSON.stringify(initialState, null, 2), 'utf8');
}

async function readState() {
  await ensureStateFile();
  const raw = await fsp.readFile(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    version: Number.isInteger(parsed.version) ? parsed.version : 0,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    data: normalizeStateData(parsed.data)
  };
}

let writeQueue = Promise.resolve();
const backupDir = path.join(dataDir, 'backups');
const MAX_BACKUPS = 10;

async function rotateBackup(currentState) {
  await fsp.mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `state_v${currentState.version}_${ts}.json`);
  await fsp.writeFile(backupFile, JSON.stringify(currentState, null, 2), 'utf8');

  const files = (await fsp.readdir(backupDir))
    .filter(f => f.startsWith('state_v') && f.endsWith('.json'))
    .sort();
  while (files.length > MAX_BACKUPS) {
    const old = files.shift();
    await fsp.unlink(path.join(backupDir, old)).catch(() => {});
  }
}

function queueWriteState(nextState, previousState) {
  writeQueue = writeQueue.then(async () => {
    if (previousState) {
      await rotateBackup(previousState).catch(err =>
        console.error('backup failed:', err)
      );
    }
    const tmpFile = `${stateFile}.tmp`;
    await fsp.writeFile(tmpFile, JSON.stringify(nextState, null, 2), 'utf8');
    await fsp.rename(tmpFile, stateFile);
  });
  return writeQueue;
}

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
  try {
    const state = await readState();
    res.json({
      ok: true,
      version: state.version,
      updatedAt: state.updatedAt,
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'health check failed' });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const state = await readState();
    res.json(state);
  } catch (error) {
    console.error('read state failed:', error);
    res.status(500).json({ message: 'read state failed' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const incomingData = req.body && req.body.data;
    if (!incomingData || typeof incomingData !== 'object') {
      res.status(400).json({ message: 'invalid data payload' });
      return;
    }

    const current = await readState();
    const baseVersion = req.body && Number.isInteger(req.body.baseVersion)
      ? req.body.baseVersion
      : null;

    if (baseVersion !== null && baseVersion !== current.version) {
      res.status(409).json({
        message: 'version conflict',
        currentVersion: current.version,
        updatedAt: current.updatedAt
      });
      return;
    }

    const nextState = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      data: normalizeStateData(incomingData)
    };

    await queueWriteState(nextState, current);
    res.json({
      ok: true,
      version: nextState.version,
      updatedAt: nextState.updatedAt
    });
  } catch (error) {
    console.error('write state failed:', error);
    res.status(500).json({ message: 'write state failed' });
  }
});

app.get('/api/backups', async (req, res) => {
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    const files = (await fsp.readdir(backupDir))
      .filter(f => f.startsWith('state_v') && f.endsWith('.json'))
      .sort()
      .reverse();
    const list = [];
    for (const f of files) {
      const stat = await fsp.stat(path.join(backupDir, f));
      list.push({ name: f, size: stat.size, mtime: stat.mtime.toISOString() });
    }
    res.json({ backups: list });
  } catch (error) {
    res.status(500).json({ message: 'list backups failed' });
  }
});

app.post('/api/restore/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename.startsWith('state_v') || !filename.endsWith('.json')) {
      res.status(400).json({ message: 'invalid backup filename' });
      return;
    }
    const backupPath = path.join(backupDir, filename);
    const raw = await fsp.readFile(backupPath, 'utf8');
    const backup = JSON.parse(raw);
    const current = await readState();
    const nextState = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      data: normalizeStateData(backup.data)
    };
    await queueWriteState(nextState, current);
    res.json({ ok: true, version: nextState.version, restoredFrom: filename });
  } catch (error) {
    console.error('restore failed:', error);
    res.status(500).json({ message: 'restore failed' });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
