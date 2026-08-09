import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;
let tiposProcessoCache = null;

// Listener em tempo real da aba "Agendamentos de Hoje"
let unsubscribeHoje = null;

document.getElementById("btn-logout")?.addEventListener("click", logout);

/* ===================================================================
   NAVEGAÇÃO POR ABAS
   =================================================================== */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => ativarAba(btn.dataset.tab));
});

function ativarAba(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("ativo"));
  document.querySelectorAll(".tab-conteudo").forEach(c => c.classList.remove("ativo"));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add("ativo");
  document.getElementById(`tab-${tab}`)?.classList.add("ativo");

  // Mantém o listener em tempo real apenas na aba "hoje"
  if (tab !== "hoje" && unsubscribeHoje) {
    unsubscribeHoje();
    unsubscribeHoje = null;
  }

  if (tab === "solicitacoes") carregarSolicitacoesPendentes();
  if (tab === "hoje") carregarAgendamentosHoje();
  if (tab === "todos") carregarTodosAgendamentos();
  if (tab === "usuarios") carregarUsuariosPendentes();
  if (tab === "processos") carregarTiposProcesso();
}

/* ===================================================================
   PROTEÇÃO DE TELA (Apenas Logística - 2 e Admin - 3)
   =================================================================== */
protegerPagina([2, 3], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;

  const nomeEl = document.getElementById("user-nome");
  const tipoEl = document.getElementById("user-tipo");
  if (nomeEl) nomeEl.textContent = perfil.nome || user.email;
  if (tipoEl) tipoEl.textContent = perfil.tipo === 3 ? "Administrador" : "Logística";

  // Carrega a aba inicial por padrão
  ativarAba("solicitacoes");
});

/* ===================================================================
   1. ABA: SOLICITAÇÕES PENDENTES
   =================================================================== */
async function carregarSolicitacoesPendentes() {
  const container = document.getElementById("lista-solicitacoes");
  if (!container) return;
  container.innerHTML = '<div class="estado-vazio">Carregando solicitações...</div>';

  try {
    const tipos = await obterTiposProcessoMap();
    const q = query(collection(db, "bookings"), where("status", "==", "Pendente"));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhuma solicitação pendente no momento.</div>';
      return;
    }

    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));

    container.innerHTML = "";
    lista.forEach(a => {
      const card = document.createElement("div");
      card.className = "item-agendamento";
      card.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">📅 ${formatarData(a.dataAgendada)} às ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge pendente">Pendente</span>
        </div>
        <div class="detalhes">
          Empresa: <strong>${escapeHtml(a.empresa || "-")}</strong><br>
          Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}
          ${a.observacoes ? `<br>Obs.: ${escapeHtml(a.observacoes)}` : ""}
        </div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button class="btn-acao btn-aprovar" data-id="${a.id}" data-data="${a.dataAgendada}" data-hora="${a.horaInicio}">Aprovar</button>
          <button class="btn-acao btn-recusar" data-id="${a.id}" data-data="${a.dataAgendada}" data-hora="${a.horaInicio}">Recusar</button>
        </div>
      `;
      container.appendChild(card);
    });

    // Eventos dos botões
    container.querySelectorAll(".btn-aprovar").forEach(btn => {
      btn.addEventListener("click", () => alterarStatusAgendamento(btn.dataset.id, "Aprovado", btn.dataset.data, btn.dataset.hora));
    });
    container.querySelectorAll(".btn-recusar").forEach(btn => {
      btn.addEventListener("click", () => alterarStatusAgendamento(btn.dataset.id, "Recusado", btn.dataset.data, btn.dataset.hora));
    });

  } catch (err) {
    console.error("Erro ao carregar solicitações:", err);
    container.innerHTML = '<div class="estado-vazio">Erro ao carregar solicitações pendentes.</div>';
  }
}

/* ===================================================================
   ALTERAR STATUS COM TRANSAÇÃO E LIBERAÇÃO DE VAGA
   =================================================================== */
async function alterarStatusAgendamento(bookingId, novoStatus, dataAgendada, horaInicio) {
  const bookingRef = doc(db, "bookings", bookingId);

  try {
    // Se o novo status for Recusado ou Cancelado, decrementa o contador 'ocupados'
    if (novoStatus === "Recusado" || novoStatus === "Cancelado") {
      const slotId = `${dataAgendada}_${(horaInicio || "").replace(":", "-")}`;
      const slotRef = doc(db, "timeSlots", slotId);

      await runTransaction(db, async (transaction) => {
        const bookingSnap = await transaction.get(bookingRef);
        const slotSnap = await transaction.get(slotRef);

        if (!bookingSnap.exists()) {
          throw new Error("Agendamento não encontrado.");
        }

        const statusAtual = bookingSnap.data().status;

        // Só libera a vaga se o agendamento não estava previamente cancelado/recusado
        if (statusAtual !== "Recusado" && statusAtual !== "Cancelado" && slotSnap.exists()) {
          const ocupadosAtuais = slotSnap.data().ocupados || 0;
          const novosOcupados = Math.max(0, ocupadosAtuais - 1);

          transaction.update(slotRef, { ocupados: novosOcupados });
        }

        transaction.update(bookingRef, {
          status: novoStatus,
          atualizadoEm: serverTimestamp(),
          atualizadoPor: usuarioAtual.uid
        });
      });
    } else {
      // Para Aprovação ou Reversão
      await updateDoc(bookingRef, {
        status: novoStatus,
        atualizadoEm: serverTimestamp(),
        atualizadoPor: usuarioAtual.uid
      });
    }

    alert(`Agendamento ${novoStatus.toLowerCase()} com sucesso!`);
    carregarSolicitacoesPendentes();
  } catch (err) {
    console.error("Erro ao alterar status:", err);
    alert("Erro ao alterar o status do agendamento: " + (err.message || "Tente novamente."));
  }
}

/* ===================================================================
   2. ABA: AGENDAMENTOS DE HOJE (TEMPO REAL)
   =================================================================== */
async function carregarAgendamentosHoje() {
  const container = document.getElementById("lista-hoje");
  if (!container) return;
  container.innerHTML = '<div class="estado-vazio">Carregando agendamentos de hoje...</div>';

  const hoje = dataDeHojeStr();
  const tipos = await obterTiposProcessoMap();

  const q = query(
    collection(db, "bookings"),
    where("dataAgendada", "==", hoje)
  );

  if (unsubscribeHoje) unsubscribeHoje();

  unsubscribeHoje = onSnapshot(q, (snap) => {
    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhum agendamento para a data de hoje.</div>';
      return;
    }

    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.horaInicio || "").localeCompare(b.horaInicio || ""));

    container.innerHTML = "";
    lista.forEach(a => {
      const card = document.createElement("div");
      card.className = "item-agendamento";
      card.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">🕒 ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge ${classeStatus(a.status)}">${escapeHtml(a.status)}</span>
        </div>
        <div class="detalhes">
          Empresa: <strong>${escapeHtml(a.empresa || "-")}</strong><br>
          Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}
        </div>
      `;
      container.appendChild(card);
    });
  }, (err) => {
    console.error("Erro no Listener de hoje:", err);
    container.innerHTML = '<div class="estado-vazio">Erro ao sincronizar agendamentos de hoje.</div>';
  });
}

/* ===================================================================
   3. ABA: TODOS OS AGENDAMENTOS
   =================================================================== */
async function carregarTodosAgendamentos() {
  const tbody = document.getElementById("tb-todos-agendamentos");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Carregando histórico...</td></tr>';

  try {
    const tipos = await obterTiposProcessoMap();
    const snap = await getDocs(collection(db, "bookings"));

    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Nenhum agendamento registrado no sistema.</td></tr>';
      return;
    }

    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (b.dataAgendada || "").localeCompare(a.dataAgendada || ""));

    tbody.innerHTML = "";
    lista.forEach(a => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatarData(a.dataAgendada)}</td>
        <td>${escapeHtml(a.horaInicio || "-")}</td>
        <td>${escapeHtml(a.empresa || "-")}</td>
        <td>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</td>
        <td>${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}</td>
        <td>${escapeHtml(a.motorista || "-")}</td>
        <td><span class="badge ${classeStatus(a.status)}">${escapeHtml(a.status)}</span></td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("Erro ao carregar todos os agendamentos:", err);
    tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Erro ao carregar histórico.</td></tr>';
  }
}

/* ===================================================================
   4. ABA: APROVAÇÃO DE USUÁRIOS COLABORADORES
   =================================================================== */
async function carregarUsuariosPendentes() {
  const container = document.getElementById("lista-pendentes-usuarios");
  if (!container) return;
  container.innerHTML = '<div class="estado-vazio">Buscando cadastros pendentes...</div>';

  try {
    const q = query(collection(db, "users"), where("status", "==", "pendente_aprovacao"));
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhum colaborador aguardando aprovação.</div>';
      return;
    }

    container.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const u = docSnap.data();
      const id = docSnap.id;

      const card = document.createElement("div");
      card.className = "item-agendamento";
      card.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">👤 ${escapeHtml(u.nome || "-")} (${escapeHtml(u.email || "-")})</span>
          <span class="badge pendente">Pendente</span>
        </div>
        <div class="detalhes" style="margin-top:8px;">
          Empresa / Setor: ${escapeHtml(u.empresa || "Interno")}
        </div>
        <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
          <select id="sel-tipo-${id}" class="campo-select" style="max-width:180px;">
            <option value="2">Logística</option>
            <option value="3">Administrador</option>
          </select>
          <button class="btn-acao btn-aprovar btn-aprovar-user" data-id="${id}">Aprovar</button>
          <button class="btn-acao btn-recusar btn-recusar-user" data-id="${id}">Recusar</button>
        </div>
      `;
      container.appendChild(card);
    });

    container.querySelectorAll(".btn-aprovar-user").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const tipoSelect = document.getElementById(`sel-tipo-${id}`);
        aprovarUsuario(id, Number(tipoSelect.value));
      });
    });

    container.querySelectorAll(".btn-recusar-user").forEach(btn => {
      btn.addEventListener("click", () => recusarUsuario(btn.dataset.id));
    });

  } catch (err) {
    console.error("Erro ao carregar usuários pendentes:", err);
    container.innerHTML = '<div class="estado-vazio">Erro ao carregar lista de usuários.</div>';
  }
}

async function aprovarUsuario(userId, tipo) {
  try {
    await updateDoc(doc(db, "users", userId), {
      tipo,
      status: "aprovado",
      aprovadoEm: serverTimestamp(),
      aprovadoPor: usuarioAtual.uid
    });
    alert("Usuário aprovado com sucesso!");
    carregarUsuariosPendentes();
  } catch (err) {
    console.error(err);
    alert("Erro ao aprovar usuário.");
  }
}

async function recusarUsuario(userId) {
  if (!confirm("Tem certeza que deseja recusar este usuário?")) return;
  try {
    await updateDoc(doc(db, "users", userId), {
      status: "recusado",
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioAtual.uid
    });
    alert("Cadastro recusado.");
    carregarUsuariosPendentes();
  } catch (err) {
    console.error(err);
    alert("Erro ao recusar usuário.");
  }
}

/* ===================================================================
   5. ABA: TIPOS DE PROCESSO
   =================================================================== */
const formProcesso = document.getElementById("form-processo");
formProcesso?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const inputNome = document.getElementById("nomeProcesso");
  const erroBox = document.getElementById("processo-error");
  const nome = inputNome.value.trim();

  if (!nome) return;
  erroBox.textContent = "";

  try {
    await addDoc(collection(db, "processTypes"), {
      nome,
      ativo: true,
      criadoEm: serverTimestamp()
    });
    inputNome.value = "";
    tiposProcessoCache = null;
    carregarTiposProcesso();
  } catch (err) {
    console.error(err);
    erroBox.textContent = "Erro ao cadastrar tipo de processo.";
  }
});

async function carregarTiposProcesso() {
  const container = document.getElementById("lista-processos");
  if (!container) return;
  container.innerHTML = '<div class="estado-vazio">Carregando tipos de processo...</div>';

  try {
    const snap = await getDocs(collection(db, "processTypes"));
    if (snap.empty) {
      container.innerHTML = '<div class="estado-vazio">Nenhum tipo de processo cadastrado.</div>';
      return;
    }

    container.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const p = docSnap.data();
      const id = docSnap.id;

      const card = document.createElement("div");
      card.className = "item-agendamento";
      card.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">${escapeHtml(p.nome)}</span>
          <button class="btn-acao ${p.ativo ? "btn-recusar" : "btn-aprovar"} btn-toggle-processo" data-id="${id}" data-ativo="${p.ativo}">
            ${p.ativo ? "Desativar" : "Ativar"}
          </button>
        </div>
      `;
      container.appendChild(card);
    });

    container.querySelectorAll(".btn-toggle-processo").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const ativo = btn.dataset.ativo === "true";
        btn.disabled = true;

        try {
          await updateDoc(doc(db, "processTypes", id), { ativo: !ativo });
          tiposProcessoCache = null;
          carregarTiposProcesso();
        } catch (err) {
          console.error(err);
          alert("Erro ao alterar status do processo.");
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="estado-vazio">Erro ao carregar tipos de processo.</div>';
  }
}

/* ===================================================================
   UTILITÁRIOS
   =================================================================== */
async function obterTiposProcessoMap() {
  if (tiposProcessoCache) return tiposProcessoCache;
  const mapa = {};
  try {
    const snap = await getDocs(collection(db, "processTypes"));
    snap.docs.forEach(d => { mapa[d.id] = d.data().nome; });
    tiposProcessoCache = mapa;
  } catch (err) {
    console.error(err);
  }
  return mapa;
}

function dataDeHojeStr() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function formatarData(dataStr) {
  if (!dataStr) return "-";
  const [ano, mes, dia] = dataStr.split("-");
  return `${dia}/${mes}/${ano}`;
}

function classeStatus(status) {
  return {
    Pendente: "pendente",
    Aprovado: "aprovado",
    Recusado: "recusado",
    Expirado: "recusado",
    Cancelado: "recusado"
  }[status] || "pendente";
}

function escapeHtml(texto) {
  if (!texto) return "";
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
