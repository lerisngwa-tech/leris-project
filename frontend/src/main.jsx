import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Candidates from "./pages/Candidates";
import Onboarding from "./pages/Onboarding";

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <nav>
      <Link to="/">Candidates</Link>
      <Link to="/onboarding">Employees</Link>
    </nav>
    <div className="container">
      <Routes>
        <Route path="/" element={<Candidates />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
    </div>
  </BrowserRouter>
);
