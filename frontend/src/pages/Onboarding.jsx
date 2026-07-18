import React, { useEffect, useState } from "react";

export default function Onboarding() {
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", department: "", start_date: "" });

  const load = () =>
    fetch("/api/employees").then((r) => r.json()).then(setEmployees);

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch("/api/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ name: "", email: "", department: "", start_date: "" });
    load();
  };

  return (
    <>
      <h2 style={{ margin: "20px 0 12px" }}>Employee Onboarding</h2>
      <form onSubmit={submit}>
        <input placeholder="Full Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input placeholder="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
        <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
        <button type="submit">Add Employee</button>
      </form>
      <table>
        <thead>
          <tr><th>Name</th><th>Email</th><th>Department</th><th>Start Date</th><th>Status</th></tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.id}>
              <td>{e.name}</td>
              <td>{e.email}</td>
              <td>{e.department}</td>
              <td>{e.start_date?.split("T")[0]}</td>
              <td><span className={`badge ${e.status}`}>{e.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
