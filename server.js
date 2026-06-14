import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import pkg from 'pg';
const { Pool } = pkg;
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── Banco de dados ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function q(text, params = []) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      "studentName" TEXT NOT NULL,
      "studentEmail" TEXT NOT NULL,
      "studentPassword" TEXT NOT NULL DEFAULT '',
      "studentPhone" TEXT DEFAULT '',
      value REAL NOT NULL,
      "dueDate" TEXT NOT NULL,
      status TEXT DEFAULT 'em_andamento',
      "paymentStatus" TEXT DEFAULT 'nao_pago',
      description TEXT DEFAULT '',
      "createdAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'),
      "updatedAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "studentPhone" TEXT DEFAULT ''`);

  await q(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      "paymentDate" TEXT NOT NULL,
      method TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      "createdAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      "eventType" TEXT NOT NULL,
      "eventDate" TEXT NOT NULL,
      description TEXT DEFAULT '',
      completed INTEGER DEFAULT 0,
      "createdAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS milestones (
      id SERIAL PRIMARY KEY,
      "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      milestone TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      "completedDate" TEXT,
      "createdAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // ── Tabelas de Finanças Pessoais ──────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS fin_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT DEFAULT '💰',
      color TEXT DEFAULT '#7c3aed'
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS fin_transactions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      date TEXT NOT NULL,
      "createdAt" TEXT DEFAULT to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Inserir categorias padrão se não existirem
  const { rows: cats } = await q(`SELECT COUNT(*) as c FROM fin_categories`);
  if (Number(cats[0].c) === 0) {
    const defaultCats = [
      // Entradas
      ['Salário',           'entrada', '💼', '#10b981'],
      ['CNPJ / Empresa',    'entrada', '🏢', '#10b981'],
      ['Freelance',         'entrada', '💻', '#06b6d4'],
      ['Outras Entradas',   'entrada', '➕', '#10b981'],
      // Saídas
      ['Aluguel',           'saida', '🏠', '#ef4444'],
      ['Mercado',           'saida', '🛒', '#f59e0b'],
      ['Assinaturas/Apps',  'saida', '📱', '#8b5cf6'],
      ['Roupas',            'saida', '👕', '#ec4899'],
      ['Cartão de Crédito', 'saida', '💳', '#ef4444'],
      ['Transporte',        'saida', '🚗', '#f97316'],
      ['Saúde',             'saida', '💊', '#14b8a6'],
      ['Alimentação/Rest.', 'saida', '🍽️', '#eab308'],
      ['Educação',          'saida', '📚', '#3b82f6'],
      ['Lazer',             'saida', '🎮', '#a855f7'],
      ['Outros Gastos',     'saida', '📦', '#94a3b8'],
    ];
    for (const [name, type, icon, color] of defaultCats) {
      await q(`INSERT INTO fin_categories (name, type, icon, color) VALUES ($1,$2,$3,$4)`, [name, type, icon, color]);
    }
  }

  console.log('✅ Base de dados inicializada com sucesso');
}

// ── Criptografia ──────────────────────────────────────────────
const KEY = Buffer.from('projectsecretkey2024financialpro'.slice(0, 32));
const IV  = Buffer.alloc(16, 0);

function encryptPassword(password) {
  if (!password) return '';
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, IV);
  return cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
}

function decryptPassword(encrypted) {
  if (!encrypted) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
    return d.update(encrypted, 'hex', 'utf8') + d.final('utf8');
  } catch { return encrypted; }
}

// ── ROTAS ─────────────────────────────────────────────────────

// Dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const { rows: projects } = await q(`SELECT * FROM projects ORDER BY "dueDate" ASC`);
    const { rows: pay } = await q(`SELECT SUM(amount) as "totalReceived" FROM payments`);

    const totalValue    = projects.reduce((s, p) => s + p.value, 0);
    const totalReceived = Number(pay[0]?.totalReceived) || 0;
    const pending       = totalValue - totalReceived;
    const now           = new Date();

    res.json({
      totalProjects: projects.length,
      totalValue, totalReceived, pending,
      completed:  projects.filter(p => p.status === 'concluido').length,
      inProgress: projects.filter(p => p.status === 'em_andamento').length,
      delayed:    projects.filter(p => new Date(p.dueDate) < now && p.status !== 'concluido' && p.status !== 'arquivado').length,
      projects
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Criar projeto
app.post('/api/projects', async (req, res) => {
  try {
    const { title, type, studentName, studentEmail, studentPassword, studentPhone, value, dueDate, description } = req.body;
    if (!title || !type || !studentName || !studentEmail || !value || !dueDate)
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });

    const enc = encryptPassword(studentPassword);
    const { rows } = await q(
      `INSERT INTO projects (title, type, "studentName", "studentEmail", "studentPassword", "studentPhone", value, "dueDate", description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [title, type, studentName, studentEmail, enc, studentPhone || '', value, dueDate, description || '']
    );
    res.status(201).json({ id: rows[0].id, message: 'Projeto criado com sucesso' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhes do projeto
app.get('/api/projects/:id', async (req, res) => {
  try {
    const { rows } = await q(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Projeto não encontrado' });
    const project = { ...rows[0], studentPassword: decryptPassword(rows[0].studentPassword) };

    const { rows: payments }   = await q(`SELECT * FROM payments   WHERE "projectId" = $1 ORDER BY "paymentDate" DESC`, [req.params.id]);
    const { rows: events }     = await q(`SELECT * FROM events     WHERE "projectId" = $1 ORDER BY "eventDate" ASC`,    [req.params.id]);
    const { rows: milestones } = await q(`SELECT * FROM milestones WHERE "projectId" = $1 ORDER BY "createdAt" ASC`,   [req.params.id]);

    res.json({ ...project, payments, events, milestones });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar projeto
app.put('/api/projects/:id', async (req, res) => {
  try {
    const { title, type, studentName, studentEmail, studentPassword, studentPhone, value, dueDate, status, paymentStatus, description } = req.body;
    const fields = [];
    const vals   = [];
    let i = 1;

    const add = (col, val) => { fields.push(`"${col}" = $${i++}`); vals.push(val); };

    if (title         !== undefined) add('title', title);
    if (type          !== undefined) add('type', type);
    if (studentName   !== undefined) add('studentName', studentName);
    if (studentEmail  !== undefined) add('studentEmail', studentEmail);
    if (studentPhone  !== undefined) add('studentPhone', studentPhone);
    if (studentPassword)             add('studentPassword', encryptPassword(studentPassword));
    if (value         !== undefined) add('value', value);
    if (dueDate       !== undefined) add('dueDate', dueDate);
    if (status        !== undefined) add('status', status);
    if (paymentStatus !== undefined) add('paymentStatus', paymentStatus);
    if (description   !== undefined) add('description', description);
    fields.push(`"updatedAt" = to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')`);
    vals.push(req.params.id);

    await q(`UPDATE projects SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    res.json({ message: 'Projeto atualizado com sucesso' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir projeto
app.delete('/api/projects/:id', async (req, res) => {
  try {
    await q(`DELETE FROM projects WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Projeto excluído' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Adicionar pagamento
app.post('/api/projects/:id/payments', async (req, res) => {
  try {
    const { amount, paymentDate, method, notes } = req.body;
    const { rows } = await q(
      `INSERT INTO payments ("projectId", amount, "paymentDate", method, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.params.id, amount, paymentDate, method || '', notes || '']
    );
    await recalcPaymentStatus(req.params.id);
    res.status(201).json({ id: rows[0].id, message: 'Pagamento registrado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir pagamento
app.delete('/api/payments/:id', async (req, res) => {
  try {
    const { rows } = await q(`SELECT "projectId" FROM payments WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Pagamento não encontrado' });
    await q(`DELETE FROM payments WHERE id = $1`, [req.params.id]);
    await recalcPaymentStatus(rows[0].projectId);
    res.json({ message: 'Pagamento excluído' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function recalcPaymentStatus(projectId) {
  const { rows: [proj] }  = await q(`SELECT value FROM projects WHERE id = $1`, [projectId]);
  const { rows: [totRow] } = await q(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE "projectId" = $1`, [projectId]);
  const paid = Number(totRow.total);
  const ps = paid >= proj.value ? 'totalmente_pago' : paid > 0 ? 'parcialmente_pago' : 'nao_pago';
  await q(`UPDATE projects SET "paymentStatus" = $1 WHERE id = $2`, [ps, projectId]);
}

// Adicionar evento
app.post('/api/projects/:id/events', async (req, res) => {
  try {
    const { eventType, eventDate, description } = req.body;
    const { rows } = await q(
      `INSERT INTO events ("projectId", "eventType", "eventDate", description) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, eventType, eventDate, description || '']
    );
    res.status(201).json({ id: rows[0].id, message: 'Evento adicionado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar evento
app.put('/api/events/:id', async (req, res) => {
  try {
    await q(`UPDATE events SET completed = $1 WHERE id = $2`, [req.body.completed ? 1 : 0, req.params.id]);
    res.json({ message: 'Evento atualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir evento
app.delete('/api/events/:id', async (req, res) => {
  try {
    await q(`DELETE FROM events WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Evento excluído' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Adicionar marco
app.post('/api/projects/:id/milestones', async (req, res) => {
  try {
    const { rows } = await q(
      `INSERT INTO milestones ("projectId", milestone) VALUES ($1,$2) RETURNING id`,
      [req.params.id, req.body.milestone]
    );
    res.status(201).json({ id: rows[0].id, message: 'Marco adicionado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar marco
app.put('/api/milestones/:id', async (req, res) => {
  try {
    const completedDate = req.body.completed ? new Date().toISOString().slice(0, 10) : null;
    await q(`UPDATE milestones SET completed = $1, "completedDate" = $2 WHERE id = $3`,
            [req.body.completed ? 1 : 0, completedDate, req.params.id]);
    res.json({ message: 'Marco atualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir marco
app.delete('/api/milestones/:id', async (req, res) => {
  try {
    await q(`DELETE FROM milestones WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Marco excluído' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Relatório financeiro
app.get('/api/financial-report', async (req, res) => {
  try {
    const { rows: projects } = await q(`SELECT * FROM projects`);
    const { rows: payments } = await q(`SELECT "projectId", SUM(amount) as total FROM payments GROUP BY "projectId"`);

    const report = {
      byStatus: { nao_pago: 0, parcialmente_pago: 0, totalmente_pago: 0 },
      byType: {}
    };

    projects.forEach(p => {
      report.byStatus[p.paymentStatus] = (report.byStatus[p.paymentStatus] || 0) + 1;
      if (!report.byType[p.type]) report.byType[p.type] = { count: 0, value: 0, received: 0 };
      const paid = Number(payments.find(x => x.projectId === p.id)?.total) || 0;
      report.byType[p.type].count++;
      report.byType[p.type].value    += p.value;
      report.byType[p.type].received += paid;
    });

    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// FINANÇAS PESSOAIS
// ══════════════════════════════════════════════════════════════

// Listar categorias
app.get('/api/fin/categories', async (req, res) => {
  try {
    const { rows } = await q(`SELECT * FROM fin_categories ORDER BY type, name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumo mensal
app.get('/api/fin/summary', async (req, res) => {
  try {
    const { month } = req.query; // formato: YYYY-MM
    const filter = month ? `WHERE date LIKE '${month}%'` : '';

    const { rows: transactions } = await q(`SELECT * FROM fin_transactions ${filter} ORDER BY date DESC`);
    const { rows: allTx }        = await q(`SELECT * FROM fin_transactions ORDER BY date DESC`);

    const totalEntradas = transactions.filter(t => t.type === 'entrada').reduce((s,t) => s + t.amount, 0);
    const totalSaidas   = transactions.filter(t => t.type === 'saida').reduce((s,t) => s + t.amount, 0);
    const saldo         = totalEntradas - totalSaidas;

    // Gastos por categoria (para o gráfico)
    const byCat = {};
    transactions.filter(t => t.type === 'saida').forEach(t => {
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    });

    // Meses disponíveis
    const months = [...new Set(allTx.map(t => t.date.slice(0,7)))].sort().reverse();

    res.json({ totalEntradas, totalSaidas, saldo, byCat, transactions, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Adicionar transação
app.post('/api/fin/transactions', async (req, res) => {
  try {
    const { type, amount, category, description, date } = req.body;
    if (!type || !amount || !category || !date)
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    const { rows } = await q(
      `INSERT INTO fin_transactions (type, amount, category, description, date) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [type, amount, category, description || '', date]
    );
    res.status(201).json({ id: rows[0].id, message: 'Transação registrada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Editar transação
app.put('/api/fin/transactions/:id', async (req, res) => {
  try {
    const { type, amount, category, description, date } = req.body;
    await q(
      `UPDATE fin_transactions SET type=$1, amount=$2, category=$3, description=$4, date=$5 WHERE id=$6`,
      [type, amount, category, description || '', date, req.params.id]
    );
    res.json({ message: 'Transação atualizada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir transação
app.delete('/api/fin/transactions/:id', async (req, res) => {
  try {
    await q(`DELETE FROM fin_transactions WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Transação excluída' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Iniciar ───────────────────────────────────────────────────
async function startServer() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`\n🚀 Servidor rodando em: http://localhost:${PORT}`);
      console.log('📊 Dashboard de Projetos Financeiros\n');
    });
  } catch (e) {
    console.error('❌ Erro ao iniciar:', e);
    process.exit(1);
  }
}

startServer();
