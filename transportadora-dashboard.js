import { auth, db } from "./firebase-config.js";
import { protegerPagina, logout } from "./auth.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  query,
  where,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;

// Horários (slots) atualmente exibidos para a data escolhida
let slotsDoDia = [];

// ---------------- Elementos ----------------
const form = document.getElementById("form-agendamento");
const selectTipoProcesso = document.getElementById("tipoProcesso");
const inputData = document.getElementById("data");
const slotsGrid = document.getElementById("slots-grid");
const slotsMsg = document.getElementById("slots-msg");
const inputHoraSelecionada = document.getElementById("horaInicioSelecionada");
const erroBox = document.getElementById("agendamento-error");
const listaAgendamentos = document.getElementById("lista-agendamentos");

// Não deixa escolher datas retroativas
inputData.min = new Date().toISOString().split("T")[0];

document.getElementById("btn-logout")?.addEventListener("click", logout);

// ---------------- Navegação por abas ----------------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("ativo"));
    document.querySelectorAll(".tab-conteudo").forEach(c => c.classList.remove("ativo"));
    btn.classList.add("ativo");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("ativo");

    if (btn.dataset.tab === "meus") carregarMeusAgendamentos();
  });
});

// ---------------- Proteção de página (apenas Tipo 1 - Transportadora) ----------------
protegerPagina([1], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;

  document.getElementById("user-empresa").textContent = perfil.empresa || perfil.nome || user.email;
  const campoEmpresa = document.getElementById("empresa");
  if (campoEmpresa && perfil.empresa) campoEmpresa.value = perfil.empresa;

  carregarTiposProcesso();
});

/* ===================================================================
   1. TIPOS DE PROCESSO
   =================================================================== */
async function carregarTiposProcesso() {
  if (!selectTipoProcesso) return;
  selectTipoProcesso.innerHTML = '<option value="">Carregando...</option>';

  try {
    const snap = await getDocs(collection(db, "processTypes"));
    selectTipoProcesso.innerHTML = '<option value="">Selecione...</option>';

    if (snap.empty) {
      selectTipoProcesso.innerHTML = '<option value="">Nenhum tipo de processo cadastrado</option>';
      return;
    }

    const opcoes = [];
    snap.forEach(documento => {
      const dados = documento.data();
      if (dados.ativo === false) return; // não exibe tipos desativados pela logística/admin
      opcoes.push({ id: documento.id, nome: dados.nome || dados.titulo || documento.id });
    });

    opcoes
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
      .forEach(op => {
        const option = document.createElement("option");
        option.value = op.id;
        option.textContent = op.nome;
        selectTipoProcesso.appendChild(option);
      });
  } catch (err) {
    console.error("Erro ao carregar tipos de processo:", err);
    selectTipoProcesso.innerHTML = '<option value="">Erro ao carregar tipos de processo</option>';
  }
}

/* ===================================================================
   2. SELEÇÃO DE DATA E HORÁRIOS (SLOTS)
   =================================================================== */
inputData.addEventListener("change", carregarSlotsDoDia);

async function carregarSlotsDoDia() {
  slotsDoDia = [];
  inputHoraSelecionada.value = "";
  slotsGrid.innerHTML = "";

  const dataStr = inputData.value;
  if (!dataStr) {
    slotsMsg.textContent = "Selecione uma data para ver os horários disponíveis.";
    slotsMsg.style.display = "block";
    return;
  }

  slotsMsg.textContent = "Carregando horários...";
  slotsMsg.style.display = "block";

  try {
    // Dia da semana calculado a partir dos componentes da string (evita bug de fuso
    // horário que ocorre ao usar "new Date('YYYY-MM-DD')" diretamente)
    const [ano, mes, dia] = dataStr.split("-").map(Number);
    const diaSemana = new Date(ano, mes - 1, dia).getDay(); // 0=domingo ... 6=sábado

    // Busca todas as janelas ativas e filtra no cliente pelo dia da semana.
    // (evita exigir índice composto de "array-contains" + igualdade no Firestore)
    const snapSlots = await getDocs(query(collection(db, "timeSlots"), where("ativo", "==", true)));

    const candidatos = [];
    snapSlots.forEach(d => {
      const s = d.data();
      if (Array.isArray(s.diasSemana) && s.diasSemana.includes(diaSemana)) {
        candidatos.push({ id: d.id, ...s });
      }
    });

    if (candidatos.length === 0) {
      slotsMsg.textContent = "Não há horários configurados para esta data. Entre em contato com a equipe de logística.";
      return;
    }

    candidatos.sort((a, b) => (a.horaInicio || "").localeCompare(b.horaInicio || ""));

    // Busca os agendamentos já existentes para a data, para calcular vagas restantes
    const snapBookings = await getDocs(
      query(collection(db, "bookings"), where("dataAgendada", "==", dataStr))
    );
    const contagemPorHorario = {};
    snapBookings.forEach(d => {
      const b = d.data();
      if (b.status === "Pendente" || b.status === "Aprovado") {
        contagemPorHorario[b.horaInicio] = (contagemPorHorario[b.horaInicio] || 0) + 1;
      }
    });

    slotsGrid.innerHTML = "";
    let algumDisponivel = false;

    candidatos.forEach(slot => {
      const ocupadas = contagemPorHorario[slot.horaInicio] || 0;
      const vagasRestantes = (slot.limiteVeiculos || 0) - ocupadas;
      if (vagasRestantes <= 0) return; // horário lotado não aparece como opção

      algumDisponivel = true;
      slotsDoDia.push(slot);

      const opcao = document.createElement("div");
      opcao.className = "slot-opcao";
      opcao.dataset.hora = slot.horaInicio;
      opcao.innerHTML = `${slot.horaInicio} - ${slot.horaFim}<small>${vagasRestantes} vaga(s) disponível(is)</small>`;
      opcao.addEventListener("click", () => {
        document.querySelectorAll(".slot-opcao").forEach(s => s.classList.remove("selecionado"));
        opcao.classList.add("selecionado");
        inputHoraSelecionada.value = slot.horaInicio;
        erroBox.textContent = "";
      });
      slotsGrid.appendChild(opcao);
    });

    if (!algumDisponivel) {
      slotsMsg.textContent = "Todos os horários desta data já estão com vagas esgotadas.";
      slotsMsg.style.display = "block";
    } else {
      slotsMsg.style.display = "none";
    }
  } catch (err) {
    console.error("Erro ao carregar horários:", err);
    slotsMsg.textContent = "Erro ao carregar horários disponíveis. Tente novamente.";
    slotsMsg.style.display = "block";
  }
}

/* ===================================================================
   3. SUBMISSÃO DO AGENDAMENTO
   =================================================================== */
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  erroBox.textContent = "";

  const dataAgendada = inputData.value;
  const horaInicio = inputHoraSelecionada.value;
  const tipoProcessoId = selectTipoProcesso.value;
  const empresa = document.getElementById("empresa").value.trim();
  const placaCavalo = document.getElementById("placaCavalo").value.trim().toUpperCase();
  const placaCarreta = document.getElementById("placaCarreta").value.trim().toUpperCase();
  const motorista = document.getElementById("motorista").value.trim();
  const observacoes = document.getElementById("observacoes").value.trim();

  if (!dataAgendada || !tipoProcessoId || !empresa || !placaCavalo || !motorista) {
    erroBox.textContent = "Preencha todos os campos obrigatórios.";
    return;
  }
  if (!horaInicio) {
    erroBox.textContent = "Selecione um horário disponível.";
    return;
  }

  const slotEscolhido = slotsDoDia.find(s => s.horaInicio === horaInicio);
  if (!slotEscolhido) {
    erroBox.textContent = "Horário inválido. Atualize a data e tente novamente.";
    return;
  }

  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Confirmando...";

  const novoBookingRef = doc(collection(db, "bookings"));

  try {
    await runTransaction(db, async (transaction) => {
      // Revalida a disponibilidade dentro da transação para evitar que duas
      // transportadoras ocupem a última vaga do mesmo horário simultaneamente
      const qConcorrentes = query(
        collection(db, "bookings"),
        where("dataAgendada", "==", dataAgendada),
        where("horaInicio", "==", horaInicio)
      );
      const snapConcorrentes = await transaction.get(qConcorrentes);

      const ocupadas = snapConcorrentes.docs.filter(d => {
        const status = d.data().status;
        return status === "Pendente" || status === "Aprovado";
      }).length;

      if (ocupadas >= (slotEscolhido.limiteVeiculos || 0)) {
        throw new Error("VAGA_ESGOTADA");
      }

      transaction.set(novoBookingRef, {
        transportadoraId: usuarioAtual.uid,
        empresa,
        dataAgendada,
        horaInicio,
        horaFim: slotEscolhido.horaFim || "",
        tipoProcessoId,
        placaCavalo,
        placaCarreta,
        motorista,
        observacoes,
        status: "Pendente",
        criadoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp()
      });
    });

    // Log de auditoria (não bloqueia o fluxo principal caso falhe)
    try {
      await addDoc(collection(db, "auditLogs"), {
        bookingId: novoBookingRef.id,
        usuarioId: usuarioAtual.uid,
        acao: "Solicitou",
        dataHora: serverTimestamp()
      });
    } catch (logErr) {
      console.warn("Falha ao registrar log de auditoria:", logErr);
    }

    alert("Agendamento solicitado com sucesso! Aguarde a aprovação da equipe de logística.");

    form.reset();
    if (perfilAtual?.empresa) document.getElementById("empresa").value = perfilAtual.empresa;
    inputHoraSelecionada.value = "";
    slotsGrid.innerHTML = "";
    slotsMsg.textContent = "Selecione uma data para ver os horários disponíveis.";
    slotsMsg.style.display = "block";
    inputData.value = "";

  } catch (err) {
    console.error(err);
    if (err.message === "VAGA_ESGOTADA") {
      erroBox.textContent = "Este horário acabou de ser preenchido por outra empresa. Escolha outro horário.";
      carregarSlotsDoDia();
    } else {
      erroBox.textContent = "Não foi possível confirmar o agendamento. Tente novamente.";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirmar Agendamento";
  }
});

/* ===================================================================
   4. MEUS AGENDAMENTOS
   =================================================================== */
let tiposProcessoCache = null;

async function carregarNomesTiposProcesso() {
  if (tiposProcessoCache) return tiposProcessoCache;
  tiposProcessoCache = {};
  try {
    const snap = await getDocs(collection(db, "processTypes"));
    snap.forEach(d => {
      const dados = d.data();
      tiposProcessoCache[d.id] = dados.nome || dados.titulo || d.id;
    });
  } catch (err) {
    console.error("Erro ao carregar nomes dos tipos de processo:", err);
  }
  return tiposProcessoCache;
}

async function carregarMeusAgendamentos() {
  if (!usuarioAtual) return;
  listaAgendamentos.innerHTML = '<div class="estado-vazio">Carregando...</div>';

  try {
    const [snap, tipos] = await Promise.all([
      getDocs(query(collection(db, "bookings"), where("transportadoraId", "==", usuarioAtual.uid))),
      carregarNomesTiposProcesso()
    ]);

    if (snap.empty) {
      listaAgendamentos.innerHTML = '<div class="estado-vazio">Você ainda não possui agendamentos.</div>';
      return;
    }

    const agendamentos = [];
    snap.forEach(d => agendamentos.push({ id: d.id, ...d.data() }));

    // Mais recentes / próximos primeiro (ordenado no cliente)
    agendamentos.sort((a, b) => {
      const chaveA = `${a.dataAgendada || ""} ${a.horaInicio || ""}`;
      const chaveB = `${b.dataAgendada || ""} ${b.horaInicio || ""}`;
      return chaveB.localeCompare(chaveA);
    });

    listaAgendamentos.innerHTML = "";
    agendamentos.forEach(a => {
      const div = document.createElement("div");
      div.className = "item-agendamento";

      const statusClasse = {
        "Pendente": "pendente",
        "Aprovado": "aprovado",
        "Recusado": "recusado",
        "Expirado": "recusado",
        "Cancelado": "recusado"
      }[a.status] || "pendente";

      div.innerHTML = `
        <div class="linha-topo">
          <span class="data-hora">${formatarData(a.dataAgendada)} às ${escapeHtml(a.horaInicio || "-")}</span>
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
function formatarData(dataStr) {
  if (!dataStr) return "-";
  const [ano, mes, dia] = dataStr.split("-");
  return `${dia}/${mes}/${ano}`;
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}
