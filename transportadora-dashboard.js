import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;

// Horários (slots) atualmente exibidos para a data escolhida
let slotsDoDia = [];

// ---------------- Elementos do DOM ----------------
const form = document.getElementById("form-agendamento");
const selectTipoProcesso = document.getElementById("tipoProcesso");
const inputData = document.getElementById("data");
const slotsGrid = document.getElementById("slots-grid");
const slotsMsg = document.getElementById("slots-msg");
const inputHoraSelecionada = document.getElementById("horaInicioSelecionada");
const erroBox = document.getElementById("agendamento-error");
const listaAgendamentos = document.getElementById("lista-agendamentos");

// Não deixa escolher datas retroativas
if (inputData) {
  inputData.min = new Date().toISOString().split("T")[0];
}

document.getElementById("btn-logout")?.addEventListener("click", logout);

// ---------------- Navegação por abas ----------------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("ativo"));
    document.querySelectorAll(".tab-conteudo").forEach(c => c.classList.remove("ativo"));
    btn.classList.add("ativo");
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add("ativo");

    if (btn.dataset.tab === "meus") {
      carregarMeusAgendamentos();
    }
  });
});

// ---------------- Proteção de Página (Apenas perfil Transportadora - Tipo 1) ----------------
protegerPagina([1], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;

  const userEmpresaEl = document.getElementById("user-empresa");
  if (userEmpresaEl) {
    userEmpresaEl.textContent = perfil.empresa || perfil.nome || user.email;
  }

  const inputEmpresa = document.getElementById("empresa");
  if (inputEmpresa && perfil.empresa) {
    inputEmpresa.value = perfil.empresa;
  }

  carregarTiposProcessoAtivos();
});

/* ===================================================================
   1. CARREGAR TIPOS DE PROCESSO ATIVOS
   =================================================================== */
async function carregarTiposProcessoAtivos() {
  if (!selectTipoProcesso) return;
  try {
    const q = query(collection(db, "processTypes"), where("ativo", "==", true));
    const snap = await getDocs(q);

    selectTipoProcesso.innerHTML = '<option value="">Selecione o tipo de processo...</option>';
    snap.docs.forEach(docSnap => {
      const p = docSnap.data();
      const opt = document.createElement("option");
      opt.value = docSnap.id;
      opt.textContent = p.nome;
      selectTipoProcesso.appendChild(opt);
    });
  } catch (err) {
    console.error("Erro ao carregar tipos de processo:", err);
  }
}

/* ===================================================================
   2. CONSULTA DE HORÁRIOS DISPONÍVEIS NA DATA (timeSlots)
   =================================================================== */
inputData?.addEventListener("change", async (e) => {
  const dataSelecionada = e.target.value;
  inputHoraSelecionada.value = "";
  slotsGrid.innerHTML = "";

  if (!dataSelecionada) {
    slotsMsg.textContent = "Selecione uma data para consultar os horários.";
    return;
  }

  slotsMsg.textContent = "Buscando horários disponíveis...";

  try {
    const qSlots = query(
      collection(db, "timeSlots"),
      where("data", "==", dataSelecionada),
      where("ativo", "==", true)
    );

    const snap = await getDocs(qSlots);

    if (snap.empty) {
      slotsMsg.textContent = "Nenhum horário/vaga disponível para esta data.";
      slotsDoDia = [];
      return;
    }

    slotsDoDia = snap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));

    // Ordena horários cronologicamente
    slotsDoDia.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));

    renderizarSlots();
  } catch (err) {
    console.error("Erro ao consultar horários:", err);
    slotsMsg.textContent = "Erro ao buscar horários para a data selecionada.";
  }
});

function renderizarSlots() {
  slotsGrid.innerHTML = "";
  slotsMsg.textContent = "";

  slotsDoDia.forEach(slot => {
    const vagasDisponiveis = slot.capacidadeMax - (slot.ocupados || 0);
    const semVaga = vagasDisponiveis <= 0;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn-slot ${semVaga ? "esgotado" : ""}`;
    btn.disabled = semVaga;

    btn.innerHTML = `
      <div style="font-weight:700; font-size:1rem;">${slot.horaInicio} às ${slot.horaFim}</div>
      <div style="font-size:0.75rem; margin-top:2px;">
        ${semVaga ? "Esgotado" : `${vagasDisponiveis} vaga(s)`}
      </div>
    `;

    if (!semVaga) {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".btn-slot").forEach(b => b.classList.remove("selecionado"));
        btn.classList.add("selecionado");
        inputHoraSelecionada.value = slot.horaInicio;
      });
    }

    slotsGrid.appendChild(btn);
  });
}

/* ===================================================================
   3. SUBMISSÃO DE NOVO AGENDAMENTO (TRANSAÇÃO ATÔMICA)
   =================================================================== */
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  erroBox.textContent = "";

  const empresa = document.getElementById("empresa").value.trim();
  const tipoProcessoId = selectTipoProcesso.value;
  const dataAgendada = inputData.value;
  const horaInicio = inputHoraSelecionada.value;
  const placaCavalo = document.getElementById("placaCavalo").value.trim().toUpperCase();
  const placaCarreta = document.getElementById("placaCarreta").value.trim().toUpperCase();
  const motorista = document.getElementById("motorista").value.trim();
  const observacoes = document.getElementById("observacoes").value.trim();

  if (!horaInicio) {
    erroBox.textContent = "Por favor, selecione um horário disponível no grid acima.";
    return;
  }

  const slotId = `${dataAgendada}_${horaInicio.replace(":", "-")}`;
  const slotRef = doc(db, "timeSlots", slotId);
  const bookingRef = doc(collection(db, "bookings"));

  const btnSub = form.querySelector("button[type=submit]");
  btnSub.disabled = true;
  btnSub.textContent = "Reservando vaga...";

  try {
    // Executa transação para evitar que 2 transportadoras peguem a última vaga simultaneamente
    await runTransaction(db, async (transaction) => {
      const slotSnap = await transaction.get(slotRef);

      if (!slotSnap.exists()) {
        throw new Error("O horário selecionado não está mais disponível.");
      }

      const slotData = slotSnap.data();
      const ocupadosAtuais = slotData.ocupados || 0;

      if (ocupadosAtuais >= slotData.capacidadeMax) {
        throw new Error("As vagas para este horário acabaram de esgotar. Escolha outro horário.");
      }

      // Incrementa ocupação da vaga
      transaction.update(slotRef, {
        ocupados: ocupadosAtuais + 1
      });

      // Salva a solicitação de agendamento
      transaction.set(bookingRef, {
        usuarioId: usuarioAtual.uid,
        empresa,
        tipoProcessoId,
        dataAgendada,
        horaInicio,
        placaCavalo,
        placaCarreta,
        motorista,
        observacoes,
        status: "Pendente",
        criadoEm: serverTimestamp()
      });
    });

    alert("Solicitação de agendamento enviada com sucesso!");
    form.reset();
    inputHoraSelecionada.value = "";
    slotsGrid.innerHTML = "";
    slotsMsg.textContent = "Selecione uma data para consultar os horários.";

  } catch (err) {
    console.error("Erro na reserva:", err);
    erroBox.textContent = err.message || "Erro ao realizar o agendamento. Tente novamente.";
  } finally {
    btnSub.disabled = false;
    btnSub.textContent = "Confirmar Agendamento";
  }
});

/* ===================================================================
   4. MEUS AGENDAMENTOS
   =================================================================== */
async function carregarMeusAgendamentos() {
  if (!listaAgendamentos) return;
  listaAgendamentos.innerHTML = '<div class="estado-vazio">Carregando seus agendamentos...</div>';

  try {
    const tipos = await obterTiposProcessoMap();
    const q = query(
      collection(db, "bookings"),
      where("usuarioId", "==", usuarioAtual.uid)
    );

    const snap = await getDocs(q);

    if (snap.empty) {
      listaAgendamentos.innerHTML = '<div class="estado-vazio">Você ainda não possui agendamentos cadastrados.</div>';
      return;
    }

    const agendamentos = snap.docs.map(d => d.data());
    agendamentos.sort((a, b) => (b.dataAgendada || "").localeCompare(a.dataAgendada || ""));

    listaAgendamentos.innerHTML = "";
    agendamentos.forEach(a => {
      const div = document.createElement("div");
      div.className = "item-agendamento";

      const statusClasse = {
        Pendente: "pendente",
        Aprovado: "aprovado",
        Recusado: "recusado",
        Expirado: "recusado",
        Cancelado: "recusado"
      }[a.status] || "pendente";

      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">📅 ${formatarData(a.dataAgendada)} às ${escapeHtml(a.horaInicio || "-")}</span>
          <span class="badge ${statusClasse}">${escapeHtml(a.status || "Pendente")}</span>
        </div>
        <div class="detalhes">
          Processo: <strong>${escapeHtml(tipos[a.tipoProcessoId] || "-")}</strong><br>
          Placas: ${escapeHtml(a.placaCavalo || "-")}${a.placaCarreta ? " / " + escapeHtml(a.placaCarreta) : ""}<br>
          Motorista: ${escapeHtml(a.motorista || "-")}
          ${a.observacoes ? `<br>Obs.: ${escapeHtml(a.observacoes)}` : ""}
        </div>
      `;
      listaAgendamentos.appendChild(div);
    });

  } catch (err) {
    console.error("Erro ao carregar agendamentos:", err);
    listaAgendamentos.innerHTML = '<div class="estado-vazio">Erro ao carregar seus agendamentos.</div>';
  }
}

/* ===================================================================
   UTILITÁRIOS
   =================================================================== */
async function obterTiposProcessoMap() {
  const map = {};
  try {
    const snap = await getDocs(collection(db, "processTypes"));
    snap.docs.forEach(d => {
      map[d.id] = d.data().nome;
    });
  } catch (err) {
    console.error(err);
  }
  return map;
}

function formatarData(dataStr) {
  if (!dataStr) return "-";
  const [ano, mes, dia] = dataStr.split("-");
  return `${dia}/${mes}/${ano}`;
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
