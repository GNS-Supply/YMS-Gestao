import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  updateDoc,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;

document.getElementById("btn-logout").addEventListener("click", logout);

// ---------------- Proteção de Página (estrita — apenas Tipo 3, Admin Master) ----------------
protegerPagina([3], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;
  document.getElementById("user-empresa").textContent = `${perfil.nome || user.email} (Admin)`;

  carregarTodosUsuarios();
  carregarResumoPendentes();
});

/* ==========================================================================
   AVISO DE COLABORADORES PENDENTES (atalho para o Painel de Logística)
   ========================================================================== */
async function carregarResumoPendentes() {
  const aviso = document.getElementById("aviso-pendentes");
  if (!aviso) return;

  try {
    const snap = await getDocs(query(collection(db, "users"), where("status", "==", "pendente_aprovacao")));

    if (snap.empty) {
      aviso.style.display = "none";
      return;
    }

    aviso.style.display = "block";
    aviso.innerHTML = `Há <strong>${snap.size}</strong> colaborador(es) aguardando aprovação de acesso.
      Isso pode ser feito na aba <em>"Aprovação de Usuários"</em> do
      <a href="logistica-dashboard.html" style="color:var(--azul-escuro); font-weight:600;">Painel de Logística</a>,
      ou diretamente aqui na tabela abaixo.`;
  } catch (err) {
    console.error("Erro ao verificar colaboradores pendentes:", err);
  }
}

/* ==========================================================================
   GESTÃO COMPLETA DE USUÁRIOS
   ========================================================================== */
async function carregarTodosUsuarios() {
  const tbody = document.getElementById("tb-todos-usuarios");
  tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Carregando usuários...</td></tr>';

  try {
    const snap = await getDocs(collection(db, "users"));

    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Nenhum usuário cadastrado.</td></tr>';
      return;
    }

    const usuarios = [];
    snap.forEach(d => usuarios.push({ id: d.id, ...d.data() }));
    usuarios.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

    tbody.innerHTML = "";
    usuarios.forEach(u => {
      const ehEuMesmo = u.id === usuarioAtual.uid;
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>
          ${escapeHtml(u.nome || "-")}
          ${ehEuMesmo ? '<br><small style="color:var(--texto-suave);">(sua conta)</small>' : ""}
        </td>
        <td>${escapeHtml(u.email || "-")}</td>
        <td>
          <span style="font-size:0.78rem; color:var(--texto-suave);">${u.vinculo === "interno" ? "Colaborador Interno" : "Empresa Parceira"}</span>
          <input type="text" class="input-empresa" data-id="${u.id}" value="${escapeHtml(u.empresa || "")}"
                 placeholder="Nome da empresa"
                 style="margin-top:4px; padding:6px 8px; border:1px solid var(--cinza-borda); border-radius:4px; font-size:0.82rem; width:100%;">
        </td>
        <td>
          <select class="select-alterar-tipo" data-id="${u.id}" ${ehEuMesmo ? "disabled" : ""} style="padding:6px; border-radius:4px; font-size:0.85rem;">
            <option value="1" ${u.tipo === 1 ? "selected" : ""}>Transportadora (1)</option>
            <option value="2" ${u.tipo === 2 ? "selected" : ""}>Logística (2)</option>
            <option value="3" ${u.tipo === 3 ? "selected" : ""}>Administrador (3)</option>
          </select>
        </td>
        <td>
          <select class="select-alterar-status" data-id="${u.id}" ${ehEuMesmo ? "disabled" : ""} style="padding:6px; border-radius:4px; font-size:0.85rem;">
            <option value="aprovado" ${u.status === "aprovado" ? "selected" : ""}>Ativo</option>
            <option value="suspenso" ${u.status === "suspenso" ? "selected" : ""}>Suspenso</option>
            <option value="pendente_aprovacao" ${u.status === "pendente_aprovacao" ? "selected" : ""}>Pendente</option>
            <option value="recusado" ${u.status === "recusado" ? "selected" : ""}>Recusado</option>
          </select>
        </td>
        <td>
          <button class="btn-acao btn-salvar-usuario" data-id="${u.id}" ${ehEuMesmo ? "disabled" : ""}>
            Salvar
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-salvar-usuario").forEach(btn => {
      btn.addEventListener("click", () => salvarUsuario(btn.dataset.id, tbody, btn));
    });
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Erro ao carregar lista de usuários.</td></tr>';
  }
}

async function salvarUsuario(idUser, tbody, btn) {
  const selectTipo = tbody.querySelector(`.select-alterar-tipo[data-id="${idUser}"]`);
  const selectStatus = tbody.querySelector(`.select-alterar-status[data-id="${idUser}"]`);
  const inputEmpresa = tbody.querySelector(`.input-empresa[data-id="${idUser}"]`);

  const novoTipo = Number(selectTipo.value);
  const novoStatus = selectStatus.value;
  const novaEmpresa = inputEmpresa.value.trim();

  const linha = btn.closest("tr");
  linha.querySelectorAll("button, select, input").forEach(el => (el.disabled = true));
  btn.textContent = "Salvando...";

  try {
    await updateDoc(doc(db, "users", idUser), {
      tipo: novoTipo,
      status: novoStatus,
      empresa: novaEmpresa,
      atualizadoEm: serverTimestamp()
    });

    alert("Usuário atualizado com sucesso!");
    carregarResumoPendentes();
  } catch (err) {
    console.error(err);
    alert("Erro ao atualizar o usuário.");
  } finally {
    linha.querySelectorAll("button, select, input").forEach(el => (el.disabled = false));
    btn.textContent = "Salvar";
  }
}

/* ==========================================================================
   UTILITÁRIOS
   ========================================================================== */
function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}
