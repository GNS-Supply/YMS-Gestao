import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");

// Mapa de redirecionamento por tipo de perfil (arquivos todos na raiz)
export const ROTAS_POR_TIPO = {
  1: "transportadora-dashboard.html",
  2: "logistica-dashboard.html",
  3: "admin-dashboard.html"
};

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";

  const email = document.getElementById("email").value.trim();
  const senha = document.getElementById("senha").value;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Entrando...";

  try {
    const cred = await signInWithEmailAndPassword(auth, email, senha);
    const userSnap = await getDoc(doc(db, "users", cred.user.uid));

    if (!userSnap.exists()) {
      throw new Error("Usuário autenticado, mas sem perfil cadastrado. Contate o administrador.");
    }

    const dadosUser = userSnap.data();

    if (dadosUser.status === "pendente_aprovacao") {
      await signOut(auth);
      throw new Error("Seu cadastro ainda está aguardando aprovação de um administrador.");
    }

    if (dadosUser.status === "recusado") {
      await signOut(auth);
      throw new Error("Seu cadastro foi recusado. Entre em contato com a equipe de logística ou administração.");
    }

    if (dadosUser.status === "suspenso") {
      await signOut(auth);
      throw new Error("Sua conta foi suspensa. Entre em contato com o administrador do sistema.");
    }

    const rota = ROTAS_POR_TIPO[dadosUser.tipo];
    if (!rota) {
      await signOut(auth);
      throw new Error("Perfil de usuário inválido ou sem acesso definido.");
    }

    window.location.href = rota;
  } catch (err) {
    console.error(err);
    errorBox.textContent = traduzErro(err.code) || err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

function traduzErro(code) {
  const mapa = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas. Tente novamente em alguns minutos."
  };
  return mapa[code];
}

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
