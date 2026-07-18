const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const client = require("prom-client");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.sendStatus(200));

// ── Prometheus metrics ────────────────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2],
  registers: [register],
});

app.use((req, res, next) => {
  const end = httpDuration.startTimer({ method: req.method, route: req.path });
  res.on("finish", () => {
    httpRequests.inc({ method: req.method, route: req.path, status: res.statusCode });
    end();
  });
  next();
});

app.get("/metrics", async (_, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

// Init tables
pool.query(`
  CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    position TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    department TEXT,
    start_date DATE,
    status TEXT DEFAULT 'onboarding'
  );
`);

// Candidates
app.get("/api/candidates", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM candidates ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/candidates", async (req, res) => {
  const { name, email, position } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO candidates (name, email, position) VALUES ($1,$2,$3) RETURNING *",
    [name, email, position]
  );
  res.status(201).json(rows[0]);
});

app.patch("/api/candidates/:id/status", async (req, res) => {
  const { status } = req.body;
  const { rows } = await pool.query(
    "UPDATE candidates SET status=$1 WHERE id=$2 RETURNING *",
    [status, req.params.id]
  );
  res.json(rows[0]);
});

// Employees
app.get("/api/employees", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM employees ORDER BY start_date DESC");
  res.json(rows);
});

app.post("/api/employees", async (req, res) => {
  const { name, email, department, start_date } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO employees (name, email, department, start_date) VALUES ($1,$2,$3,$4) RETURNING *",
    [name, email, department, start_date]
  );
  res.status(201).json(rows[0]);
});

app.listen(3000, () => console.log("Backend running on port 3000"));
