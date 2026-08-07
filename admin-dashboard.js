import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection, doc, getDocs, updateDoc, addDoc,
  query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;

// Eventos Globais
document.getElementById("btn-logout").addEventListener("click", logout);

// Navegação por Abas
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("ativo"));
    document.querySelectorAll(".tab-conteudo").forEach(c => c.classList.remove("ativo"));
    btn.classList.add("ativo");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("ativo");

    // Recarrega dados conforme a aba aberta
    if (btn.dataset.tab === "usuarios") carregarUsuariosPendentes();
    if (btn.dataset.tab === "gestao-usuarios") carregarTodosUsuarios();
    if (btn.dataset.tab === "processos") carregarTiposProcesso();
  });
});

// Proteção de Página (Apenas Perfil Tipo 3 - Admin)
protegerPagina([3], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;
  document.getElementById("user-empresa").textContent = `${perfil.nome || user.email} (Admin)`;
  
  carregarUsuariosPendentes();
});

/* ==========================================================================
   1. APROVAÇÃO DE USUÁRIOS PENDENTES
   ========================================================================== */
async function carregarUsuariosPendentes() {
  const container = document.getElementById("lista-pendentes");
  container.innerHTML = '<div class="estado-vazio">Carregando solicitações...</div>';

  try {
    const q = query(collection(db, "users"), where("status", "==", "pendente_aprovacao"));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhuma solicitação pendente no momento.</div>';
      return;
    }

    container.innerHTML = "";
    snap.forEach(d => {
      const u = d.data();
      const item = document.createElement("div");
      item.className = "item-agendamento";
      item.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">${escapeHtml(u.nome || "Sem Nome")}</span>
          <span class="badge pendente">Pendente</span>
        </div>
        <div class="detalhes">
          E-mail: <strong>${escapeHtml(u.email)}</strong><br>
          Vínculo: ${u.vinculo === "interno" ? "Colaborador Interno" : "Empresa Parceira"}
        </div>
        <div style="margin-top:12px; display:flex; gap:10px; align-items:center;">
          <select id="select-perfil-${d.id}" style="padding:6px; border-radius:4px; font-size:0.85rem;">
            <option value="2">Atribuir como Logística (Tipo 2)</option>
            <option value="3">Atribuir como Administrador (Tipo 3)</option>
            <option value="1">Atribuir como Transportadora (Tipo 1)</option>
          </select>
          <button class="btn-acao btn-aprovar" data-id="${d.id}">Aprovar</button>
        </div>
      `;
      container.appendChild(item);
    });

    // Eventos dos botões de aprovação
    container.querySelectorAll(".btn-aprovar").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idUser = e.target.dataset.id;
        const tipoEscolhido = Number(document.getElementById(`select-perfil-${idUser}`).value);
        
        e.target.disabled = true;
        e.target.textContent = "Aprovando...";

        try {
          await updateDoc(doc(db, "users", idUser), {
            status: "aprovado",
            tipo: tipoEscolhido,
            atualizadoEm: serverTimestamp()
          });
          alert("Usuário aprovado com sucesso!");
          carregarUsuariosPendentes();
        } catch (err) {
          console.error(err);
          alert("Erro ao aprovar usuário.");
          e.target.disabled = false;
          e.target.textContent = "Aprovar";
        }
      });
    });

  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="estado-vazio">Erro ao carregar solicitações.</div>';
  }
}

/* ==========================================================================
   2. GESTÃO DE TODOS OS USUÁRIOS
   ========================================================================== */
async function carregarTodosUsuarios() {
  const tbody = document.getElementById("tb-todos-usuarios");
  tbody.innerHTML = '<tr><td colspan="5" class="estado-vazio">Carregando usuários...</td></tr>';

  try {
    const snap = await getDocs(collection(db, "users"));
    tbody.innerHTML = "";

    snap.forEach(d => {
      const u = d.data();
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${escapeHtml(u.nome || "-")}</td>
        <td>${escapeHtml(u.email || "-")}</td>
        <td>${u.vinculo === "interno" ? "Interno" : `Externo (${escapeHtml(u.empresa || "-")})`}</td>
        <td>
          <select class="select-alterar-tipo" data-id="${d.id}" ${d.id === usuarioAtual.uid ? "disabled" : ""}>
            <option value="1" ${u.tipo === 1 ? "selected" : ""}>Transportadora (1)</option>
            <option value="2" ${u.tipo === 2 ? "selected" : ""}>Logística (2)</option>
            <option value="3" ${u.tipo === 3 ? "selected" : ""}>Administrador (3)</option>
          </select>
        </td>
        <td>
          <button class="btn-acao btn-salvar-tipo" data-id="${d.id}" ${d.id === usuarioAtual.uid ? "disabled" : ""}>
            Salvar
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-salvar-tipo").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idUser = e.target.dataset.id;
        const select = tbody.querySelector(`.select-alterar-tipo[data-id="${idUser}"]`);
        const novoTipo = Number(select.value);

        e.target.disabled = true;
        e.target.textContent = "Salvar...";

        try {
          await updateDoc(doc(db, "users", idUser), {
            tipo: novoTipo,
            atualizadoEm: serverTimestamp()
          });
          alert("Perfil do usuário atualizado!");
        } catch (err) {
          console.error(err);
          alert("Erro ao atualizar o perfil do usuário.");
        } finally {
          e.target.disabled = false;
          e.target.textContent = "Salvar";
        }
      });
    });

  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="5" class="estado-vazio">Erro ao carregar lista de usuários.</td></tr>';
  }
}

/* ==========================================================================
   3. CADASTRO E GERENCIAMENTO DE TIPOS DE PROCESSO
   ========================================================================== */
document.getElementById("form-processo").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById("processo-error");
  errorBox.textContent = "";

  const nome = document.getElementById("nomeProcesso").value.trim();
  if (!nome) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Salvando...";

  try {
    await addDoc(collection(db, "processTypes"), {
      nome,
      ativo: true,
      criadoEm: serverTimestamp()
    });

    e.target.reset();
    carregarTiposProcesso();
  } catch (err) {
    console.error(err);
    errorBox.textContent = "Erro ao cadastrar o tipo de processo.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Cadastrar Processo";
  }
});

async function carregarTiposProcesso() {
  const container = document.getElementById("lista-processos");
  container.innerHTML = '<div class="estado-vazio">Carregando processos...</div>';

  try {
    const snap = await getDocs(collection(db, "processTypes"));

    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhum tipo de processo cadastrado.</div>';
      return;
    }

    container.innerHTML = "";
    snap.forEach(d => {
      const p = d.data();
      const item = document.createElement("div");
      item.className = "item-agendamento";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "center";

      item.innerHTML = `
        <div>
          <strong>${escapeHtml(p.nome)}</strong>
          <small style="display:block; color:var(--texto-suave);">
            Status: ${p.ativo ? "Ativo" : "Inativo"}
          </small>
        </div>
        <button class="btn-acao ${p.ativo ? 'btn-desativar' : 'btn-aprovar'}" data-id="${d.id}" data-ativo="${p.ativo}">
          ${p.ativo ? "Desativar" : "Ativar"}
        </button>
      `;
      container.appendChild(item);
    });

    container.querySelectorAll(".btn-acao").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.dataset.id;
        const statusAtual = e.target.dataset.ativo === "true";

        try {
          await updateDoc(doc(db, "processTypes", id), {
            ativo: !statusAtual
          });
          carregarTiposProcesso();
        } catch (err) {
          console.error(err);
          alert("Erro ao alterar o status do processo.");
        }
      });
    });

  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="estado-vazio">Erro ao carregar tipos de processo.</div>';
  }
}

/* ==========================================================================
   UTILITÁRIOS
   ========================================================================== */
function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}
