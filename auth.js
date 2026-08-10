// =====================================================================
// auth.js — Utilitários de autenticação reaproveitados nas telas
// protegidas (admin-dashboard.html, logistica-dashboard.html,
// portaria.html).
//
// LIMPEZA: este arquivo já teve, no topo, uma cópia completa do
// listener de login (#login-form, sign-in, traduzErro, ROTAS_POR_TIPO)
// — mas nenhuma página que importa auth.js tem um elemento
// #login-form no DOM, então esse bloco nunca executava (form
// resolvia para null e o addEventListener opcional nunca disparava).
// A tela de login de fato é index.html, que mantém sua própria cópia
// inline dessa mesma lógica. ROTAS_POR_TIPO também nunca era
// importado daqui por ninguém (index.html e cadastro.html têm cada
// um a própria cópia). Removido tudo isso; o que sobra abaixo é
// exatamente o que outras telas de fato importam.
// =====================================================================

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Utilitário reaproveitável nas outras telas para proteger páginas
export function protegerPagina(tiposPermitidos, callback) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || snap.data().status !== "aprovado" || !tiposPermitidos.includes(snap.data().tipo)) {
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }
    callback(user, snap.data());
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = "index.html";
}
