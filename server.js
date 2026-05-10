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
const dailyLogDir = path.join(dataDir, 'daily-logs');
const auditLogDir = path.join(dataDir, 'audit-logs');
const MAX_BACKUPS = 50;
const MAX_AUDIT_DAYS = 180;

function detectPointChanges(oldStudents, newStudents) {
  const oldMap = new Map((oldStudents || []).map(s => [s.id, s]));
  const newMap = new Map((newStudents || []).map(s => [s.id, s]));
  const changes = [];
  const now = new Date().toISOString();

  for (const [id, newS] of newMap) {
    const oldS = oldMap.get(id);
    if (!oldS) {
      if (newS.points !== 0) {
        changes.push({
          timestamp: now,
          studentId: id,
          studentName: newS.name || '',
          type: 'new_student',
          before: 0,
          after: newS.points,
          delta: newS.points
        });
      }
    } else if (oldS.points !== newS.points) {
      changes.push({
        timestamp: now,
        studentId: id,
        studentName: newS.name || oldS.name || '',
        type: newS.points > oldS.points ? 'earn' : 'use',
        before: oldS.points,
        after: newS.points,
        delta: newS.points - oldS.points
      });
    }
  }

  for (const [id, oldS] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({
        timestamp: now,
        studentId: id,
        studentName: oldS.name || '',
        type: 'student_removed',
        before: oldS.points,
        after: 0,
        delta: -oldS.points
      });
    }
  }

  return changes;
}

async function writeAuditLog(changes, version) {
  if (!changes.length) return;
  await fsp.mkdir(auditLogDir, { recursive: true });
  const today = todayKey();
  const logFile = path.join(auditLogDir, `${today}.jsonl`);
  const lines = changes.map(c => JSON.stringify({ ...c, version })).join('\n') + '\n';
  await fsp.appendFile(logFile, lines, 'utf8');
}

async function rotateAuditLogs() {
  await fsp.mkdir(auditLogDir, { recursive: true });
  const files = (await fsp.readdir(auditLogDir))
    .filter(f => f.endsWith('.jsonl'))
    .sort();
  while (files.length > MAX_AUDIT_DAYS) {
    const old = files.shift();
    await fsp.unlink(path.join(auditLogDir, old)).catch(() => {});
  }
}

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

    const pointChanges = detectPointChanges(current.data.students, nextState.data.students);

    await queueWriteState(nextState, current);

    if (pointChanges.length > 0) {
      writeAuditLog(pointChanges, nextState.version).catch(err =>
        console.error('audit log failed:', err)
      );
    }

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
      const isManual = f.includes('_manual') || /_[a-zA-Z\u4e00-\u9fff]/.test(f.replace(/^state_v\d+_[\d\-T]+Z?_?/, ''));
      const raw = await fsp.readFile(path.join(backupDir, f), 'utf8').catch(() => null);
      let studentCount = 0;
      let txnCount = 0;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.data) {
            studentCount = Array.isArray(parsed.data.students) ? parsed.data.students.length : 0;
            txnCount = Array.isArray(parsed.data.transactions) ? parsed.data.transactions.length : 0;
          }
        } catch (_) {}
      }
      list.push({ name: f, size: stat.size, mtime: stat.mtime.toISOString(), isManual, studentCount, txnCount });
    }
    res.json({ backups: list });
  } catch (error) {
    res.status(500).json({ message: 'list backups failed' });
  }
});

app.post('/api/snapshot', async (req, res) => {
  try {
    const current = await readState();
    const label = (req.body && req.body.label) || 'manual';
    const safeLabel = label.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').slice(0, 30);
    await fsp.mkdir(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `state_v${current.version}_${ts}_${safeLabel}.json`;
    await fsp.writeFile(
      path.join(backupDir, filename),
      JSON.stringify(current, null, 2),
      'utf8'
    );
    res.json({ ok: true, filename, version: current.version });
  } catch (error) {
    console.error('snapshot failed:', error);
    res.status(500).json({ message: 'snapshot failed' });
  }
});

app.post('/api/restore/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename.endsWith('.json') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
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

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function createDailyLog() {
  const today = todayKey();
  await fsp.mkdir(dailyLogDir, { recursive: true });
  const logFile = path.join(dailyLogDir, `${today}.json`);

  if (fs.existsSync(logFile)) return null;

  const state = await readState();
  const students = (state.data.students || []).map(s => ({
    id: s.id,
    name: s.name,
    points: s.points,
    cardId: s.cardId || null
  }));

  const todayTxns = (state.data.transactions || []).filter(t => {
    return t.date && t.date.startsWith(today);
  });

  const log = {
    date: today,
    createdAt: new Date().toISOString(),
    version: state.version,
    studentCount: students.length,
    students,
    transactionCount: todayTxns.length,
    todayTransactions: todayTxns
  };

  await fsp.writeFile(logFile, JSON.stringify(log, null, 2), 'utf8');

  await rotateBackup(state);

  console.log(`[Daily Log] ${today} saved: ${students.length} students, ${todayTxns.length} txns`);
  return log;
}

const MAX_DAILY_LOGS = 90;
async function rotateDailyLogs() {
  await fsp.mkdir(dailyLogDir, { recursive: true });
  const files = (await fsp.readdir(dailyLogDir))
    .filter(f => f.endsWith('.json'))
    .sort();
  while (files.length > MAX_DAILY_LOGS) {
    const old = files.shift();
    await fsp.unlink(path.join(dailyLogDir, old)).catch(() => {});
  }
}

async function updateTodayLog() {
  const today = todayKey();
  await fsp.mkdir(dailyLogDir, { recursive: true });
  const logFile = path.join(dailyLogDir, `${today}.json`);

  const state = await readState();
  const students = (state.data.students || []).map(s => ({
    id: s.id,
    name: s.name,
    points: s.points,
    cardId: s.cardId || null
  }));

  const todayTxns = (state.data.transactions || []).filter(t => {
    return t.date && t.date.startsWith(today);
  });

  const log = {
    date: today,
    createdAt: new Date().toISOString(),
    version: state.version,
    studentCount: students.length,
    students,
    transactionCount: todayTxns.length,
    todayTransactions: todayTxns
  };

  await fsp.writeFile(logFile, JSON.stringify(log, null, 2), 'utf8');
}

app.get('/api/daily-logs', async (req, res) => {
  try {
    await fsp.mkdir(dailyLogDir, { recursive: true });
    const files = (await fsp.readdir(dailyLogDir))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    const logs = [];
    for (const f of files) {
      const raw = await fsp.readFile(path.join(dailyLogDir, f), 'utf8').catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        logs.push({
          date: parsed.date,
          createdAt: parsed.createdAt,
          version: parsed.version,
          studentCount: parsed.studentCount,
          transactionCount: parsed.transactionCount
        });
      } catch (_) {}
    }
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ message: 'list daily logs failed' });
  }
});

app.get('/api/daily-logs/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ message: 'invalid date format, use YYYY-MM-DD' });
      return;
    }
    const logFile = path.join(dailyLogDir, `${date}.json`);
    const raw = await fsp.readFile(logFile, 'utf8').catch(() => null);
    if (!raw) {
      res.status(404).json({ message: 'no log for this date' });
      return;
    }
    res.json(JSON.parse(raw));
  } catch (error) {
    res.status(500).json({ message: 'read daily log failed' });
  }
});

app.get('/api/daily-logs/student/:studentId', async (req, res) => {
  try {
    const studentId = req.params.studentId;
    await fsp.mkdir(dailyLogDir, { recursive: true });
    const files = (await fsp.readdir(dailyLogDir))
      .filter(f => f.endsWith('.json'))
      .sort();

    const history = [];
    for (const f of files) {
      const raw = await fsp.readFile(path.join(dailyLogDir, f), 'utf8').catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const student = (parsed.students || []).find(s => s.id === studentId);
        if (student) {
          history.push({ date: parsed.date, points: student.points, name: student.name });
        }
      } catch (_) {}
    }
    res.json({ studentId, history });
  } catch (error) {
    res.status(500).json({ message: 'read student history failed' });
  }
});

app.post('/api/daily-logs/save-now', async (req, res) => {
  try {
    await updateTodayLog();
    res.json({ ok: true, date: todayKey() });
  } catch (error) {
    console.error('save daily log failed:', error);
    res.status(500).json({ message: 'save daily log failed' });
  }
});

// ========== 审计日志 API ==========

app.get('/api/audit-logs', async (req, res) => {
  try {
    await fsp.mkdir(auditLogDir, { recursive: true });
    const files = (await fsp.readdir(auditLogDir))
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const list = files.map(f => ({
      date: f.replace('.jsonl', ''),
      filename: f
    }));
    res.json({ logs: list });
  } catch (error) {
    res.status(500).json({ message: 'list audit logs failed' });
  }
});

app.get('/api/audit-logs/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ message: 'invalid date format, use YYYY-MM-DD' });
      return;
    }
    const logFile = path.join(auditLogDir, `${date}.jsonl`);
    const raw = await fsp.readFile(logFile, 'utf8').catch(() => null);
    if (!raw) {
      res.json({ date, entries: [] });
      return;
    }
    const entries = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);

    const { studentId, type } = req.query;
    let filtered = entries;
    if (studentId) filtered = filtered.filter(e => e.studentId === studentId);
    if (type) filtered = filtered.filter(e => e.type === type);

    res.json({ date, total: filtered.length, entries: filtered });
  } catch (error) {
    res.status(500).json({ message: 'read audit log failed' });
  }
});

app.get('/api/audit-logs/student/:studentId', async (req, res) => {
  try {
    const studentId = req.params.studentId;
    const { from, to } = req.query;
    await fsp.mkdir(auditLogDir, { recursive: true });
    const files = (await fsp.readdir(auditLogDir))
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => {
        const d = f.replace('.jsonl', '');
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      })
      .sort();

    const entries = [];
    for (const f of files) {
      const raw = await fsp.readFile(path.join(auditLogDir, f), 'utf8').catch(() => null);
      if (!raw) continue;
      const lines = raw.trim().split('\n');
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.studentId === studentId) entries.push(entry);
        } catch (_) {}
      }
    }

    res.json({ studentId, total: entries.length, entries });
  } catch (error) {
    res.status(500).json({ message: 'read student audit log failed' });
  }
});

// ========== 批量积分恢复 API ==========

app.post('/api/batch-restore', async (req, res) => {
  try {
    const { restorations } = req.body;
    if (!Array.isArray(restorations) || restorations.length === 0) {
      res.status(400).json({ message: 'restorations array required, e.g. [{studentId, targetPoints}]' });
      return;
    }

    const current = await readState();
    const students = [...current.data.students];
    const results = [];

    for (const r of restorations) {
      const idx = students.findIndex(s => s.id === r.studentId);
      if (idx === -1) {
        results.push({ studentId: r.studentId, status: 'not_found' });
        continue;
      }
      const before = students[idx].points;
      students[idx] = { ...students[idx], points: r.targetPoints };
      results.push({
        studentId: r.studentId,
        name: students[idx].name,
        before,
        after: r.targetPoints,
        status: 'restored'
      });
    }

    const nextState = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      data: { ...current.data, students }
    };

    const pointChanges = detectPointChanges(current.data.students, nextState.data.students);
    await queueWriteState(nextState, current);

    if (pointChanges.length > 0) {
      for (const c of pointChanges) c.type = 'batch_restore';
      writeAuditLog(pointChanges, nextState.version).catch(err =>
        console.error('audit log failed:', err)
      );
    }

    res.json({
      ok: true,
      version: nextState.version,
      totalRequested: restorations.length,
      restored: results.filter(r => r.status === 'restored').length,
      notFound: results.filter(r => r.status === 'not_found').length,
      results
    });
  } catch (error) {
    console.error('batch restore failed:', error);
    res.status(500).json({ message: 'batch restore failed' });
  }
});

app.post('/api/batch-restore-from-date', async (req, res) => {
  try {
    const { date, studentIds } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ message: 'date required (YYYY-MM-DD)' });
      return;
    }

    const logFile = path.join(dailyLogDir, `${date}.json`);
    const raw = await fsp.readFile(logFile, 'utf8').catch(() => null);
    if (!raw) {
      res.status(404).json({ message: `no daily log found for ${date}` });
      return;
    }
    const logData = JSON.parse(raw);
    const logStudents = logData.students || [];

    let targetStudents = logStudents;
    if (Array.isArray(studentIds) && studentIds.length > 0) {
      const idSet = new Set(studentIds);
      targetStudents = logStudents.filter(s => idSet.has(s.id));
    }

    if (targetStudents.length === 0) {
      res.status(400).json({ message: 'no matching students found in that date\'s log' });
      return;
    }

    const restorations = targetStudents.map(s => ({
      studentId: s.id,
      targetPoints: s.points
    }));

    const current = await readState();
    const students = [...current.data.students];
    const results = [];

    for (const r of restorations) {
      const idx = students.findIndex(s => s.id === r.studentId);
      if (idx === -1) {
        results.push({ studentId: r.studentId, status: 'not_found' });
        continue;
      }
      const before = students[idx].points;
      students[idx] = { ...students[idx], points: r.targetPoints };
      results.push({
        studentId: r.studentId,
        name: students[idx].name,
        before,
        after: r.targetPoints,
        status: 'restored'
      });
    }

    const nextState = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      data: { ...current.data, students }
    };

    const pointChanges = detectPointChanges(current.data.students, nextState.data.students);
    await queueWriteState(nextState, current);

    if (pointChanges.length > 0) {
      for (const c of pointChanges) c.type = 'batch_restore';
      writeAuditLog(pointChanges, nextState.version).catch(err =>
        console.error('audit log failed:', err)
      );
    }

    res.json({
      ok: true,
      version: nextState.version,
      restoredFromDate: date,
      totalRequested: restorations.length,
      restored: results.filter(r => r.status === 'restored').length,
      notFound: results.filter(r => r.status === 'not_found').length,
      results
    });
  } catch (error) {
    console.error('batch restore from date failed:', error);
    res.status(500).json({ message: 'batch restore from date failed' });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let dailyLogTimer = null;

function startDailyLogScheduler() {
  createDailyLog().catch(err => console.error('[Daily Log] init error:', err));

  dailyLogTimer = setInterval(async () => {
    try {
      await createDailyLog();
      await rotateDailyLogs();
      await rotateAuditLogs();
    } catch (err) {
      console.error('[Daily Log] scheduler error:', err);
    }
  }, 60 * 60 * 1000);

  console.log('[Daily Log] Scheduler started (hourly check)');
}

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  startDailyLogScheduler();
});
