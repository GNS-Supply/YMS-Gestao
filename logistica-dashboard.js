import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;
let tiposProcessoCache = null;

// Listener em tempo real da aba "Agendamentos de Hoje"
let unsubscribeHoje = null;

document.getElementById("btn-logout")?.addEventListener("click", logout);

/* ===================================================================
   ELEMENTOS DO DOM
   =================================================================== */
// Agendamentos
const listaSolicitacoes = document.getElementById("lista-solicitacoes");
const listaHoje = document.getElementById("lista-hoje");
const listaTodos = document.getElementById("lista-todos");
const filtroDataGeral = document.getElementById("filtroDataGeral");

// Gestão de Vagas (Slots)
const formSlot = document.getElementById("form-slot");
const slotDataInput = document.getElementById("slotData");
const slotHoraInicio = document.getElementById("slotHoraInicio");
const slotHoraFim = document.getElementById("slotHoraFim");
const slotCapacidade = document.getElementById("slotCapacidade");
const slotError = document.getElementById("slot-error");
const filtroDataSlot = document.getElementById("filtroDataSlot");
const listaSlots = document.getElementById("lista-slots");

// Usuários Pendentes
const listaPendentesUsuarios = document.getElementById("lista-pendentes-usuarios");

// Tipos de Processo
const formProcesso = document.getElementById("form-processo");
const nomeProcessoInput = document.getElementById("nomeProcesso");
const processoError = document.getElementById("processo-error");
const listaProcessos = document.getElementById("lista-processos");

/* ===================================================================
   PROTEÇÃO DE PÁGINA (Permite tipos 2 - Logística e 3 - Admin)
   =================================================================== */
protegerPagina([2, 3], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;

  document.getElementById("user-nome").textContent = perfil.nome || user.email;
  document.getElementById("user-tipo").textContent = perfil.tipo === 3 ? "Administrador" : "Logística";

  // Define datas padrão nos inputs de filtro
  const hojeStr = dataDeHojeStr();
  if (filtroDataGeral) filtroDataGeral.value = hojeStr;
  if (slotDataInput) slotDataInput.value = hojeStr;
  if (filtroDataSlot) filtroDataSlot.value = hojeStr;

  // Carrega visão inicial
  carregarSolicitacoes();
});

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

  if (tab === "solicitacoes") carregarSolicitacoes();
  if (tab === "hoje") carregarAgendamentosHoje();
  if (tab === "todos") carregarTodosAgendamentos(filtroDataGeral?.value || dataDeHojeStr());
  if (tab === "slots") carregarSlotsGerenciamento(filtroDataSlot?.value || dataDeHojeStr());
  if (tab === "usuarios") carregarUsuariosPendentes();
  if (tab === "processos") carregarTiposProcesso();
}

filtroDataGeral?.addEventListener("change", (e) => carregarTodosAgendamentos(e.target.value));
filtroDataSlot?.addEventListener("change", (e) => carregarSlotsGerenciamento(e.target.value));

/* ===================================================================
   1. ABA: SOLICITAÇÕES PENDENTES DE AGENDAMENTO
   =================================================================== */
async function carregarSolicitacoes() {
  if (!listaSolicitacoes) return;
  listaSolicitacoes.innerHTML = '<div class="estado-vazio">Carregando solicitações...</div>';

  try {
    const tipos = await obterTiposProcessoMap();
    const q = query(collection(db, "bookings"), where("status", "==", "Pendente"));
    const snap = await getDocs(q);

    if (snap.empty) {
      listaSolicitacoes.innerHTML = '<div class="estado-vazio">Nenhuma solicitação pendente no momento.</div>';
      return;
    }

    listaSolicitacoes.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const a = docSnap.data();
      const idDoc = docSnap.id;

      const div = document.createElement("div");
      div.className = "item-agendamento";
      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">📅 ${formatarData(a.dataAgendada)} às ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge pendente">Pendente</span>
        </div>
        <div class="detalhes" style="margin-bottom:10px;">
          Empresa: <strong>${escapeHtml(a.empresa || "-")}</strong><br>
          Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}<br>
          ${a.observacoes ? `Obs.: ${escapeHtml(a.observacoes)}<br>` : ""}
          <small style="color:var(--texto-suave)">Solicitado por UID: ${a.usuarioId}</small>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="btn-acao btn-aprovar-booking" data-id="${idDoc}" style="background:var(--verde); color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">Aprovar</button>
          <button class="btn-acao btn-recusar-booking" data-id="${idDoc}" style="background:var(--vermelho); color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">Recusar</button>
        </div>
      `;
      listaSolicitacoes.appendChild(div);
    });

    document.querySelectorAll(".btn-aprovar-booking").forEach(b => {
      b.addEventListener("click", () => responderAgendamento(b.dataset.id, "Aprovado"));
    });
    document.querySelectorAll(".btn-recusar-booking").forEach(b => {
      b.addEventListener("click", () => responderAgendamento(b.dataset.id, "Recusado"));
    });

  } catch (err) {
    console.error("Erro ao carregar solicitações:", err);
    listaSolicitacoes.innerHTML = '<div class="estado-vazio">Erro ao carregar solicitações.</div>';
  }
}

async function responderAgendamento(idBooking, novoStatus) {
  if (!confirm(`Confirma definir esta solicitação como "${novoStatus}"?`)) return;

  try {
    await updateDoc(doc(db, "bookings", idBooking), {
      status: novoStatus,
      atualizadoPor: usuarioAtual.uid,
      atualizadoEm: serverTimestamp()
    });

    // Registra Log de Auditoria
    await addDoc(collection(db, "auditLogs"), {
      bookingId: idBooking,
      acao: novoStatus === "Aprovado" ? "APROVAR_AGENDAMENTO" : "RECUSAR_AGENDAMENTO",
      executadoPor: usuarioAtual.uid,
      dataHora: serverTimestamp()
    });

    alert(`Agendamento ${novoStatus.toLowerCase()} com sucesso!`);
    carregarSolicitacoes();
  } catch (err) {
    console.error("Erro ao atualizar agendamento:", err);
    alert("Erro ao processar ação.");
  }
}

/* ===================================================================
   2. ABA: AGENDAMENTOS DE HOJE (TEMPO REAL)
   =================================================================== */
function carregarAgendamentosHoje() {
  if (!listaHoje) return;
  listaHoje.innerHTML = '<div class="estado-vazio">Carregando agendamentos de hoje...</div>';

  const hojeStr = dataDeHojeStr();
  const q = query(collection(db, "bookings"), where("dataAgendada", "==", hojeStr));

  if (unsubscribeHoje) unsubscribeHoje();

  unsubscribeHoje = onSnapshot(q, async (snap) => {
    if (snap.empty) {
      listaHoje.innerHTML = `<div class="estado-vazio">Nenhum agendamento para hoje (${formatarData(hojeStr)}).</div>`;
      return;
    }

    const tipos = await obterTiposProcessoMap();
    listaHoje.innerHTML = "";

    snap.docs.forEach(docSnap => {
      const a = docSnap.data();
      const div = document.createElement("div");
      div.className = "item-agendamento";
      
      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">⏰ ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge ${classeStatus(a.status)}">${escapeHtml(a.status || "Pendente")}</span>
        </div>
        <div class="detalhes">
          Empresa: <strong>${escapeHtml(a.empresa || "-")}</strong> | Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}
        </div>
      `;
      listaHoje.appendChild(div);
    });
  }, (err) => {
    console.error("Erro em tempo real:", err);
    listaHoje.innerHTML = '<div class="estado-vazio">Erro ao carregar atualizações.</div>';
  });
}

/* ===================================================================
   3. ABA: TODOS OS AGENDAMENTOS (POR DATA)
   =================================================================== */
async function carregarTodosAgendamentos(dataStr) {
  if (!listaTodos) return;
  listaTodos.innerHTML = '<div class="estado-vazio">Carregando agendamentos...</div>';

  try {
    const tipos = await obterTiposProcessoMap();
    const q = query(collection(db, "bookings"), where("dataAgendada", "==", dataStr));
    const snap = await getDocs(q);

    if (snap.empty) {
      listaTodos.innerHTML = `<div class="estado-vazio">Nenhum agendamento encontrado para ${formatarData(dataStr)}.</div>`;
      return;
    }

    listaTodos.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const a = docSnap.data();
      const div = document.createElement("div");
      div.className = "item-agendamento";
      
      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">📅 ${formatarData(a.dataAgendada)} às ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge ${classeStatus(a.status)}">${escapeHtml(a.status || "Pendente")}</span>
        </div>
        <div class="detalhes">
          Empresa: <strong>${escapeHtml(a.empresa || "-")}</strong> | Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}
        </div>
      `;
      listaTodos.appendChild(div);
    });
  } catch (err) {
    console.error(err);
    listaTodos.innerHTML = '<div class="estado-vazio">Erro ao carregar lista.</div>';
  }
}

/* ===================================================================
   4. ABA: GESTÃO DE VAGAS E HORÁRIOS (TIMESLOTS)
   =================================================================== */
formSlot?.addEventListener("submit", async (e) => {
  e.preventDefault();
  slotError.textContent = "";

  const dataStr = slotDataInput.value;
  const horaInicio = slotHoraInicio.value;
  const horaFim = slotHoraFim.value;
  const capacidade = Number(slotCapacidade.value);

  if (horaInicio >= horaFim) {
    slotError.textContent = "O horário de início deve ser menor que o horário de término.";
    return;
  }

  const btn = formSlot.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Criando...";

  try {
    // ID único e padronizado por data e hora para evitar duplicidades
    const slotId = `${dataStr}_${horaInicio.replace(":", "-")}`;
    const docRef = doc(db, "timeSlots", slotId);

    await setDoc(docRef, {
      data: dataStr,
      horaInicio: horaInicio,
      horaFim: horaFim,
      capacidadeMax: capacidade,
      ocupados: 0,
      ativo: true,
      criadoEm: serverTimestamp()
    }, { merge: true });

    alert("Horário/Vaga cadastrado com sucesso!");
    formSlot.reset();
    slotDataInput.value = dataStr;
    slotCapacidade.value = 2;
    carregarSlotsGerenciamento(dataStr);
  } catch (err) {
    console.error("Erro ao criar horário:", err);
    slotError.textContent = "Erro ao salvar o horário. Verifique as permissões.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Criar Vaga / Horário";
  }
});

async function carregarSlotsGerenciamento(dataStr) {
  if (!listaSlots) return;
  listaSlots.innerHTML = '<div class="estado-vazio">Carregando horários...</div>';

  try {
    const qSlots = query(collection(db, "timeSlots"), where("data", "==", dataStr));
    const snap = await getDocs(qSlots);

    if (snap.empty) {
      listaSlots.innerHTML = `<div class="estado-vazio">Nenhum horário cadastrado para ${formatarData(dataStr)}.</div>`;
      return;
    }

    listaSlots.innerHTML = "";
    const slots = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    slots.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));

    slots.forEach(slot => {
      const div = document.createElement("div");
      div.className = "item-agendamento";
      
      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">⏰ ${slot.horaInicio} às ${slot.horaFim}</span>
          <span class="badge ${slot.ocupados >= slot.capacidadeMax ? 'recusado' : 'aprovado'}">
            Ocupação: ${slot.ocupados || 0} / ${slot.capacidadeMax}
          </span>
        </div>
        <div class="detalhes" style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
          <div>Data: <strong>${formatarData(slot.data)}</strong></div>
          <button class="btn-excluir-slot" data-id="${slot.id}" style="background:var(--vermelho); color:white; border:none; padding:4px 10px; border-radius:4px; font-size:0.8rem; cursor:pointer;">
            Remover Vaga
          </button>
        </div>
      `;

      listaSlots.appendChild(div);
    });

    document.querySelectorAll(".btn-excluir-slot").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idSlot = e.target.dataset.id;
        if (confirm("Tem certeza que deseja remover esta vaga de horário?")) {
          try {
            await deleteDoc(doc(db, "timeSlots", idSlot));
            carregarSlotsGerenciamento(dataStr);
          } catch (err) {
            console.error(err);
            alert("Erro ao remover o horário.");
          }
        }
      });
    });

  } catch (err) {
    console.error("Erro ao carregar slots:", err);
    listaSlots.innerHTML = '<div class="estado-vazio">Erro ao carregar os horários.</div>';
  }
}

/* ===================================================================
   5. ABA: APROVAÇÃO DE USUÁRIOS INTERNOS
   =================================================================== */
async function carregarUsuariosPendentes() {
  if (!listaPendentesUsuarios) return;
  listaPendentesUsuarios.innerHTML = '<div class="estado-vazio">Carregando solicitações...</div>';

  try {
    const q = query(collection(db, "users"), where("status", "==", "pendente_aprovacao"));
    const snap = await getDocs(q);

    if (snap.empty) {
      listaPendentesUsuarios.innerHTML = '<div class="estado-vazio">Nenhum colaborador aguardando aprovação.</div>';
      return;
    }

    listaPendentesUsuarios.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const u = docSnap.data();
      const idUser = docSnap.id;

      const div = document.createElement("div");
      div.className = "item-agendamento";
      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">👤 ${escapeHtml(u.nome || u.email)}</span>
          <span class="badge pendente">Pendente</span>
        </div>
        <div class="detalhes" style="margin-bottom:10px;">
          E-mail: <strong>${escapeHtml(u.email || "-")}</strong><br>
          Empresa/Vínculo: ${escapeHtml(u.empresa || "-")}
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <select id="sel-tipo-${idUser}" style="padding:4px 8px; border-radius:4px; border:1px solid var(--cinza-borda);">
            <option value="2">Perfil Logística (Tipo 2)</option>
            <option value="3">Perfil Admin (Tipo 3)</option>
          </select>
          <button class="btn-aprovar-user" data-id="${idUser}" style="background:var(--verde); color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">Aprovar</button>
          <button class="btn-recusar-user" data-id="${idUser}" style="background:var(--vermelho); color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;">Recusar</button>
        </div>
      `;
      listaPendentesUsuarios.appendChild(div);
    });

    document.querySelectorAll(".btn-aprovar-user").forEach(b => {
      b.addEventListener("click", () => {
        const id = b.dataset.id;
        const tipoEscolhido = Number(document.getElementById(`sel-tipo-${id}`).value);
        aprovarUsuarioInternal(id, tipoEscolhido, "aprovado");
      });
    });

    document.querySelectorAll(".btn-recusar-user").forEach(b => {
      b.addEventListener("click", () => {
        aprovarUsuarioInternal(b.dataset.id, 1, "recusado");
      });
    });

  } catch (err) {
    console.error("Erro ao carregar usuários pendentes:", err);
    listaPendentesUsuarios.innerHTML = '<div class="estado-vazio">Erro ao carregar lista de usuários.</div>';
  }
}

async function aprovarUsuarioInternal(idUser, novoTipo, novoStatus) {
  try {
    await updateDoc(doc(db, "users", idUser), {
      tipo: novoTipo,
      status: novoStatus,
      atualizadoEm: serverTimestamp()
    });

    alert(`Utilizador ${novoStatus === 'aprovado' ? 'aprovado' : 'recusado'} com sucesso!`);
    carregarUsuariosPendentes();
  } catch (err) {
    console.error(err);
    alert("Erro ao alterar utilizador.");
  }
}

/* ===================================================================
   6. ABA: TIPOS DE PROCESSO
   =================================================================== */
formProcesso?.addEventListener("submit", async (e) => {
  e.preventDefault();
  processoError.textContent = "";

  const nome = nomeProcessoInput.value.trim();
  if (!nome) return;

  const btn = formProcesso.querySelector("button[type=submit]");
  btn.disabled = true;

  try {
    await addDoc(collection(db, "processTypes"), {
      nome: nome,
      ativo: true,
      criadoEm: serverTimestamp()
    });

    nomeProcessoInput.value = "";
    tiposProcessoCache = null;
    carregarTiposProcesso();
  } catch (err) {
    console.error(err);
    processoError.textContent = "Erro ao cadastrar tipo de processo.";
  } finally {
    btn.disabled = false;
  }
});

async function carregarTiposProcesso() {
  if (!listaProcessos) return;
  listaProcessos.innerHTML = '<div class="estado-vazio">Carregando processos...</div>';

  try {
    const snap = await getDocs(collection(db, "processTypes"));
    if (snap.empty) {
      listaProcessos.innerHTML = '<div class="estado-vazio">Nenhum processo cadastrado.</div>';
      return;
    }

    listaProcessos.innerHTML = "";
    snap.docs.forEach(docSnap => {
      const p = docSnap.data();
      const div = document.createElement("div");
      div.className = "item-agendamento";
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      div.style.alignItems = "center";

      div.innerHTML = `
        <div>
          <strong>${escapeHtml(p.nome)}</strong>
          <span class="badge ${p.ativo ? 'aprovado' : 'recusado'}" style="margin-left:8px;">${p.ativo ? 'Ativo' : 'Inativo'}</span>
        </div>
        <button class="btn-toggle-processo" data-id="${docSnap.id}" data-ativo="${p.ativo}" style="background:var(--azul); color:white; border:none; padding:4px 10px; border-radius:4px; font-size:0.8rem; cursor:pointer;">
          ${p.ativo ? 'Desativar' : 'Ativar'}
        </button>
      `;
      listaProcessos.appendChild(div);
    });

    document.querySelectorAll(".btn-toggle-processo").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.dataset.id;
        const statusAtual = e.target.dataset.ativo === "true";
        e.target.disabled = true;

        try {
          await updateDoc(doc(db, "processTypes", id), { ativo: !statusAtual });
          tiposProcessoCache = null;
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
    listaProcessos.innerHTML = '<div class="estado-vazio">Erro ao carregar tipos de processo.</div>';
  }
}

/* ===================================================================
   UTILITÁRIOS INTERNOS
   =================================================================== */
async function obterTiposProcessoMap() {
  if (tiposProcessoCache) return tiposProcessoCache;
  const map = {};
  try {
    const snap = await getDocs(collection(db, "processTypes"));
    snap.docs.forEach(d => {
      map[d.id] = d.data().nome;
    });
    tiposProcessoCache = map;
  } catch (err) {
    console.error("Erro ao carregar mapa de processos:", err);
  }
  return map;
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
