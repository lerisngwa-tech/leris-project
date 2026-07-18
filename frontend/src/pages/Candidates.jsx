import React, { useEffect, useState } from "react";

export default function Candidates() {
  const [candidates, setCandidates] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", position: "" });

  const load = () =>
    fetch("/api/candidates").then((r) => r.json()).then(setCandidates);

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ name: "", email: "", position: "" });
    load();
  };

  const updateStatus = async (id, status) => {
    await fetch(`/api/candidates/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  };

  return (
    <>
      <h2 style={{ margin: "20px 0 12px" }}>Candidates</h2>
      <form onSubmit={submit}>
        <input placeholder="Full Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input placeholder="Position" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        <button type="submit">Add Candidate</button>
      </form>
      <table>
        <thead>
          <tr><th>Name</th><th>Email</th><th>Position</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {candidates.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.email}</td>
              <td>{c.position}</td>
              <td><span className={`badge ${c.status}`}>{c.status}</span></td>
              <td style={{ display: "flex", gap: 6 }}>
                <button onClick={() => updateStatus(c.id, "approved")}>Approve</button>
                <button style={{ background: "#dc3545" }} onClick={() => updateStatus(c.id, "rejected")}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
