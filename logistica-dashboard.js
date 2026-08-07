import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;
let tiposProcessoCache = null;

// Listener em tempo real da aba "Agendamentos de Hoje" (precisa ser
// desligado ao sair da aba para não continuar consumindo leituras)
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

  // Só mantém o listener em tempo real ativo enquanto a aba "hoje" está visível
  if (tab !== "hoje" && unsubscribeHoje) {
    unsubscribeHoje();
    unsubscribeHoje = null;
  }

  if (tab === "solicitacoes") carregarSolicitacoesPendentes();
  if (tab === "hoje") observarAgendamentosHoje();
  if (tab === "todos") {
    const dataFiltro = document.getElementById("filtro-data").value;
    if (dataFiltro) carregarTodosAgendamentos(dataFiltro);
  }
  if (tab === "processos") carregarTiposProcesso();
}

/* ===================================================================
   PROTEÇÃO DE PÁGINA (Tipo 2 - Logística, Tipo 3 - Admin Master)
   =================================================================== */
protegerPagina([2, 3], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;

  document.getElementById("user-nome").textContent = perfil.nome || user.email;
  document.getElementById("user-tipo").textContent = perfil.tipo === 3 ? "Administrador" : "Logística";

  carregarSolicitacoesPendentes();
});

/* ===================================================================
   NOMES DOS TIPOS DE PROCESSO (cache usado nas tabelas)
   =================================================================== */
async function carregarNomesTiposProcesso(forcarAtualizacao = false) {
  if (tiposProcessoCache && !forcarAtualizacao) return tiposProcessoCache;
  tiposProcessoCache = {};
  try {
    const snap = await getDocs(collection(db, "processTypes"));
    snap.forEach(d => {
      const dados = d.data();
      tiposProcessoCache[d.id] = dados.nome || dados.titulo || d.id;
    });
  } catch (err) {
    console.error("Erro ao carregar tipos de processo:", err);
  }
  return tiposProcessoCache;
}

/* ===================================================================
   1. SOLICITAÇÕES PENDENTES (Aprovar / Recusar agendamentos)
   =================================================================== */
async function carregarSolicitacoesPendentes() {
  const tbody = document.getElementById("tabela-pendentes");
  tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Carregando solicitações...</td></tr>';

  try {
    const [snap, tipos] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("status", "==", "Pendente"))),
      carregarNomesTiposProcesso()
    ]);

    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Nenhuma solicitação pendente no momento.</td></tr>';
      return;
    }

    const pendentes = [];
    snap.forEach(d => pendentes.push({ id: d.id, ...d.data() }));
    pendentes.sort((a, b) =>
      `${a.dataAgendada || ""} ${a.horaInicio || ""}`.localeCompare(`${b.dataAgendada || ""} ${b.horaInicio || ""}`)
    );

    tbody.innerHTML = "";
    pendentes.forEach(b => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatarData(b.dataAgendada)} ${escapeHtml(b.horaInicio || "-")}</td>
        <td>${escapeHtml(b.empresa || "-")}</td>
        <td>${escapeHtml(tipos[b.tipoProcessoId] || "-")}</td>
        <td>${escapeHtml(b.placaCavalo || "-")}${b.placaCarreta ? " / " + escapeHtml(b.placaCarreta) : ""}</td>
        <td>${escapeHtml(b.motorista || "-")}</td>
        <td>${escapeHtml(b.observacoes || "-")}</td>
        <td style="white-space:nowrap;">
          <button class="btn-acao btn-aprovar" data-id="${b.id}" style="margin-right:6px;">Aprovar</button>
          <button class="btn-acao btn-desativar" data-id="${b.id}">Recusar</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-aprovar").forEach(btn => {
      btn.addEventListener("click", () => atualizarStatusBooking(btn.dataset.id, "Aprovado", "Aprovou"));
    });
    tbody.querySelectorAll(".btn-desativar").forEach(btn => {
      btn.addEventListener("click", () => atualizarStatusBooking(btn.dataset.id, "Recusado", "Recusou"));
    });
  } catch (err) {
    console.error("Erro ao carregar solicitações pendentes:", err);
    tbody.innerHTML = '<tr><td colspan="7" class="estado-vazio">Erro ao carregar solicitações.</td></tr>';
  }
}

async function atualizarStatusBooking(bookingId, novoStatus, acaoLog) {
  const botaoClicado =
    document.querySelector(`.btn-aprovar[data-id="${bookingId}"]`) ||
    document.querySelector(`.btn-desativar[data-id="${bookingId}"]`);
  const linha = botaoClicado?.closest("tr");
  linha?.querySelectorAll("button").forEach(b => (b.disabled = true));

  try {
    await updateDoc(doc(db, "bookings", bookingId), {
      status: novoStatus,
      atualizadoEm: serverTimestamp()
    });

    try {
      await addDoc(collection(db, "auditLogs"), {
        bookingId,
        usuarioId: usuarioAtual.uid,
        acao: acaoLog,
        dataHora: serverTimestamp()
      });
    } catch (logErr) {
      console.warn("Falha ao registrar log de auditoria:", logErr);
    }

    carregarSolicitacoesPendentes();
  } catch (err) {
    console.error(`Erro ao processar ação "${acaoLog}" no agendamento:`, err);
    alert(`Não foi possível ${novoStatus === "Aprovado" ? "aprovar" : "recusar"} o agendamento.`);
    linha?.querySelectorAll("button").forEach(b => (b.disabled = false));
  }
}

/* ===================================================================
   2. AGENDAMENTOS DE HOJE (atualização em tempo real)
   =================================================================== */
function observarAgendamentosHoje() {
  const tbody = document.getElementById("tabela-hoje");
  tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Carregando agenda do dia...</td></tr>';

  if (unsubscribeHoje) {
    unsubscribeHoje();
    unsubscribeHoje = null;
  }

  const hojeStr = dataDeHojeStr();
  const q = query(collection(db, "bookings"), where("dataAgendada", "==", hojeStr));

  unsubscribeHoje = onSnapshot(
    q,
    async (snap) => {
      const tipos = await carregarNomesTiposProcesso();

      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Nenhum agendamento para hoje.</td></tr>';
        return;
      }

      const agendamentos = [];
      snap.forEach(d => agendamentos.push({ id: d.id, ...d.data() }));
      agendamentos.sort((a, b) => (a.horaInicio || "").localeCompare(b.horaInicio || ""));

      tbody.innerHTML = "";
      agendamentos.forEach(b => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(b.horaInicio || "-")}</td>
          <td>${escapeHtml(b.empresa || "-")}</td>
          <td>${escapeHtml(tipos[b.tipoProcessoId] || "-")}</td>
          <td>${escapeHtml(b.placaCavalo || "-")}${b.placaCarreta ? " / " + escapeHtml(b.placaCarreta) : ""}</td>
          <td>${escapeHtml(b.motorista || "-")}</td>
          <td><span class="badge ${classeStatus(b.status)}">${escapeHtml(b.status || "-")}</span></td>
        `;
        tbody.appendChild(tr);
      });
    },
    (err) => {
      console.error("Erro ao observar agenda de hoje:", err);
      tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Erro ao carregar agenda do dia.</td></tr>';
    }
  );
}

/* ===================================================================
   3. TODOS OS AGENDAMENTOS (consulta histórica por data)
   =================================================================== */
document.getElementById("filtro-data").addEventListener("change", (e) => {
  if (e.target.value) carregarTodosAgendamentos(e.target.value);
});

async function carregarTodosAgendamentos(dataStr) {
  const tbody = document.getElementById("tabela-todos");
  tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Carregando...</td></tr>';

  try {
    const [snap, tipos] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("dataAgendada", "==", dataStr))),
      carregarNomesTiposProcesso()
    ]);

    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Nenhum agendamento encontrado para esta data.</td></tr>';
      return;
    }

    const agendamentos = [];
    snap.forEach(d => agendamentos.push({ id: d.id, ...d.data() }));
    agendamentos.sort((a, b) => (a.horaInicio || "").localeCompare(b.horaInicio || ""));

    tbody.innerHTML = "";
    agendamentos.forEach(b => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatarData(b.dataAgendada)} ${escapeHtml(b.horaInicio || "-")}</td>
        <td>${escapeHtml(b.empresa || "-")}</td>
        <td>${escapeHtml(tipos[b.tipoProcessoId] || "-")}</td>
        <td>${escapeHtml(b.placaCavalo || "-")}${b.placaCarreta ? " / " + escapeHtml(b.placaCarreta) : ""}</td>
        <td>${escapeHtml(b.motorista || "-")}</td>
        <td><span class="badge ${classeStatus(b.status)}">${escapeHtml(b.status || "-")}</span></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Erro ao consultar agendamentos:", err);
    tbody.innerHTML = '<tr><td colspan="6" class="estado-vazio">Erro ao consultar agendamentos.</td></tr>';
  }
}

/* ===================================================================
   4. TIPOS DE PROCESSO (cadastrar / ativar / desativar)
   =================================================================== */
document.getElementById("form-processo")?.addEventListener("submit", async (e) => {
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
    tiposProcessoCache = null; // força atualização do cache usado nas outras tabelas
    await carregarTiposProcesso();
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

    const processos = [];
    snap.forEach(d => processos.push({ id: d.id, ...d.data() }));
    processos.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

    container.innerHTML = "";
    processos.forEach(p => {
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
        <button class="btn-acao ${p.ativo ? "btn-desativar" : "btn-aprovar"}" data-id="${p.id}" data-ativo="${p.ativo}">
          ${p.ativo ? "Desativar" : "Ativar"}
        </button>
      `;
      container.appendChild(item);
    });

    container.querySelectorAll(".btn-acao").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.dataset.id;
        const statusAtual = e.target.dataset.ativo === "true";
        e.target.disabled = true;

        try {
          await updateDoc(doc(db, "processTypes", id), { ativo: !statusAtual });
          tiposProcessoCache = null; // força atualização do cache usado nas outras tabelas
          carregarTiposProcesso();
        } catch (err) {
          console.error(err);
          alert("Erro ao alterar o status do processo.");
          e.target.disabled = false;
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
  return (
    {
      Pendente: "pendente",
      Aprovado: "aprovado",
      Recusado: "recusado",
      Expirado: "recusado",
      Cancelado: "recusado"
    }[status] || "pendente"
  );
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}
