import { auth, db } from "./firebase-config.js";
import { ROTAS_POR_TIPO } from "./auth.js";
import {
  createUserWithEmailAndPassword,
  signOut,
  deleteUser
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, setDoc, getDocs, collection, query, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const form = document.getElementById("cadastro-form");
const errorBox = document.getElementById("cadastro-error");
const camposExterno = document.getElementById("campos-externo");
const avisoInterno = document.getElementById("aviso-interno");

// Alterna os campos extras conforme o vínculo escolhido
document.querySelectorAll('input[name="vinculo"]').forEach(radio => {
  radio.addEventListener("change", (e) => {
    const externo = e.target.value === "externo";
    camposExterno.style.display = externo ? "block" : "none";
    avisoInterno.style.display = externo ? "none" : "block";
    document.getElementById("empresa").required = externo;
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";

  const nome = document.getElementById("nome").value.trim();
  const email = document.getElementById("email").value.trim();
  const senha = document.getElementById("senha").value;
  const confirmarSenha = document.getElementById("confirmarSenha").value;
  const vinculo = document.querySelector('input[name="vinculo"]:checked').value;

  if (senha !== confirmarSenha) {
    errorBox.textContent = "As senhas não coincidem.";
    return;
  }

  let empresa = "";
  let tipoVinculo = "";
  if (vinculo === "externo") {
    empresa = document.getElementById("empresa").value.trim();
    tipoVinculo = document.getElementById("tipoVinculo").value;
    if (!empresa) {
      errorBox.textContent = "Informe o nome da empresa.";
      return;
    }
  }

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Criando conta...";

  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, senha);
  } catch (err) {
    console.error(err);
    errorBox.textContent = traduzErro(err.code) || "Não foi possível criar a conta.";
    btn.disabled = false;
    btn.textContent = "Criar Conta";
    return;
  }

  try {
    // Se a coleção "users" ainda está vazia, este é o usuário fundador
    // do sistema e vira Admin Master aprovado automaticamente.
    const usersSnap = await getDocs(query(collection(db, "users"), limit(1)));
    const ehPrimeiroUsuario = usersSnap.empty;

    const dadosBase = {
      nome,
      email,
      vinculo, // "interno" | "externo"
      criadoEm: serverTimestamp()
    };

    let dadosUser;
    if (ehPrimeiroUsuario) {
      dadosUser = { ...dadosBase, tipo: 3, status: "aprovado" };
    } else if (vinculo === "interno") {
      dadosUser = { ...dadosBase, tipo: null, status: "pendente_aprovacao" };
    } else {
      dadosUser = { ...dadosBase, tipo: 1, status: "aprovado", empresa, tipoVinculo };
    }

    await setDoc(doc(db, "users", cred.user.uid), dadosUser);

    if (dadosUser.status === "pendente_aprovacao") {
      await signOut(auth);
      alert(" enviado! Você poderá entrar assim que um administrador aprovar seu acesso.");
      window.location.href = "index.html";
      return;
    }

    // Aprovado (fundador ou externo) — já segue direto para a área correta
    window.location.href = ROTAS_POR_TIPO[dadosUser.tipo];

  } catch (err) {
    console.error(err);
    // A conta no Auth já foi criada mas o perfil no Firestore falhou —
    // desfaz a criação da conta para não deixar usuário "fantasma" sem perfil.
    try { await deleteUser(cred.user); } catch (_) {}
    errorBox.textContent = "Não foi possível concluir o cadastro. Tente novamente.";
    btn.disabled = false;
    btn.textContent = "Criar Conta";
  }
});

function traduzErro(code) {
  const mapa = {
    "auth/email-already-in-use": "Este e-mail já está cadastrado.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "A senha precisa ter no mínimo 6 caracteres."
  };
  return mapa[code];
}
