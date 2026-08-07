import { auth, db } from "./Firebase-config.js";
import { protegerPagina, logout } from "./Auth.js";
import {
  collection, doc, getDocs,
  query, where, orderBy, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let usuarioAtual = null;
let perfilAtual = null;
let horariosDisponiveis = [];

document.getElementById("btn-logout").addEventListener("click", logout);
document.getElementById("data").min = new Date().toISOString().split("T")[0];

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("ativo"));
    document.querySelectorAll(".tab-conteudo").forEach(c => c.classList.remove("ativo"));
    btn.classList.add("ativo");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("ativo");
    if (btn.dataset.tab === "meus") carregarMeusAgendamentos();
  });
});

protegerPagina([1], (user, perfil) => {
  usuarioAtual = user;
  perfilAtual = perfil;
  document.getElementById("user-empresa").textContent = perfil.empresa || perfil.nome || "";
  document.getElementById("empresa").value = perfil.empresa || "";
  carregarTiposProcesso();
});

async function carregarTiposProcesso() {
  const select = document.getElementById("tipoProcesso");
  const snap = await getDocs(query(collection(db, "processTypes"), where("ativo", "==", true)));
  snap.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.data().nome;
    select.appendChild(opt);
  });
}

document.getElementById("data").addEventListener("change", carregarHorariosDoDia);

async function carregarHorariosDoDia() {
  const dataStr = document.getElementById("data").value;
  const grid = document.getElementById("slots-grid");
  const msg = document.getElementById("slots-msg");
  document.getElementById("horaInicioSelecionada").value = "";
  grid.innerHTML = "";
  horariosDisponiveis = [];

  if (!dataStr) return;
  msg.textContent = "Carregando horários...";

  const diaSemana = new Date(dataStr + "T00:00:00").getDay();

  const slotsSnap = await getDocs(query(collection(db, "timeSlots"), where("ativo", "==", true)));
  const slotsDoDia = slotsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => Array.isArray(s.diasSemana) && s.diasSemana.includes(diaSemana))
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));

  if (slotsDoDia.length === 0) {
    msg.textContent = "Não há horários configurados para esse dia. Contate a equipe de logística.";
    return;
  }

  const bookingsSnap = await getDocs(query(
    collection(db, "bookings"),
    where("dataAgendada", "==", dataStr),
    where("status", "in", ["Pendente", "Aprovado"])
  ));
  const contagemPorHora = {};
  bookingsSnap.forEach(d => {
    const h = d.data().horaInicio;
    contagemPorHora[h] = (contagemPorHora[h] || 0) + 1;
  });

  let algumDisponivel = false;
  grid.innerHTML = "";
  slotsDoDia.forEach(slot => {
    const ocupadas = contagemPorHora[slot.horaInicio] || 0;
    const vagasLivres = slot.limiteVeiculos - ocupadas;
    if (vagasLivres <= 0) return;

    algumDisponivel = true;
    horariosDisponiveis.push(slot);

    const opcao = document.createElement("div");
    opcao.className = "slot-opcao";
    opcao.innerHTML = `${slot.horaInicio} - ${slot.horaFim}<small>${vagasLivres} vaga(s)</small>`;
    opcao.addEventListener("click", () => {
      document.querySelectorAll(".slot-opcao").forEach(el => el.classList.remove("selecionado"));
      opcao.classList.add("selecionado");
      document.getElementById("horaInicioSelecionada").value = slot.horaInicio;
    });
    grid.appendChild(opcao);
  });

  msg.textContent = algumDisponivel
    ? "Selecione um horário abaixo."
    : "Não há vagas disponíveis para essa data. Escolha outra data ou contate a logística.";
}

document.getElementById("form-agendamento").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById("agendamento-error");
  errorBox.textContent = "";

  const dataStr = document.getElementById("data").value;
  const horaInicio = document.getElementById("horaInicioSelecionada").value;
  const tipoProcessoSelect = document.getElementById("tipoProcesso");
  const tipoProcessoId = tipoProcessoSelect.value;

  if (!dataStr || !horaInicio) {
    errorBox.textContent = "Selecione uma data e um horário disponível.";
    return;
  }
  if (!tipoProcessoId) {
    errorBox.textContent = "Selecione o tipo de processo.";
    return;
  }

  const slot = horariosDisponiveis.find(s => s.horaInicio === horaInicio);
  if (!slot) {
    errorBox.textContent = "Horário inválido. Selecione novamente.";
    return;
  }

  const dadosBooking = {
    transportadoraId: usuarioAtual.uid,
    empresa: document.getElementById("empresa").value.trim(),
    dataAgendada: dataStr,
    horaInicio,
    tipoProcessoId,
    tipoProcessoNome: tipoProcessoSelect.options[tipoProcessoSelect.selectedIndex].textContent,
    placaCavalo: document.getElementById("placaCavalo").value.trim().toUpperCase(),
    placaCarreta: document.getElementById("placaCarreta").value.trim().toUpperCase(),
    motorista: document.getElementById("motorista").value.trim(),
    observacoes: document.getElementById("observacoes").value.trim(),
    status: "Pendente"
  };

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Agendando...";

  try {
    const contadorId = `${dataStr}_${horaInicio}`;
    const contadorRef = doc(db, "slotCounts", contadorId);
    const timeSlotRef = doc(db, "timeSlots", slot.id);
    const bookingRef = doc(collection(db, "bookings"));
    const logRef = doc(collection(db, "auditLogs"));

    await runTransaction(db, async (tx) => {
      const contadorSnap = await tx.get(contadorRef);
      const timeSlotSnap = await tx.get(timeSlotRef);

      const limite = timeSlotSnap.exists() ? timeSlotSnap.data().limiteVeiculos : slot.limiteVeiculos;
      const atual = contadorSnap.exists() ? contadorSnap.data().contagem : 0;

      if (atual >= limite) {
        throw new Error("VAGA_ESGOTADA");
      }

      tx.set(contadorRef, { contagem: atual + 1, data: dataStr, horaInicio }, { merge: true });
      tx.set(bookingRef, {
        ...dadosBooking,
        criadoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp()
      });
      tx.set(logRef, {
        bookingId: bookingRef.id,
        usuarioId: usuarioAtual.uid,
        acao: "Solicitou",
        dataHora: serverTimestamp()
      });
    });

    alert("Agendamento solicitado com sucesso! Aguarde a aprovação da logística.");
    e.target.reset();
    document.getElementById("empresa").value = perfilAtual.empresa || "";
    document.getElementById("slots-grid").innerHTML = "";
    document.getElementById("slots-msg").textContent = "Selecione uma data para ver os horários disponíveis.";
    document.querySelector('.tab-btn[data-tab="meus"]').click();

  } catch (err) {
    console.error(err);
    if (err.message === "VAGA_ESGOTADA") {
      errorBox.textContent = "Essa vaga acabou de ser preenchida. Escolha outro horário.";
      carregarHorariosDoDia();
    } else {
      errorBox.textContent = "Não foi possível concluir o agendamento. Tente novamente.";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirmar Agendamento";
  }
});

async function carregarMeusAgendamentos() {
  const lista = document.getElementById("lista-agendamentos");
  lista.innerHTML = '<div class="estado-vazio">Carregando...</div>';

  const snap = await getDocs(query(
    collection(db, "bookings"),
    where("transportadoraId", "==", usuarioAtual.uid),
    orderBy("criadoEm", "desc")
  ));

  if (snap.empty) {
    lista.innerHTML = '<div class="estado-vazio">Você ainda não possui agendamentos.</div>';
    return;
  }

  lista.innerHTML = "";
  snap.forEach(d => {
    const b = d.data();
    const div = document.createElement("div");
    div.className = "item-agendamento";
    div.innerHTML = `
      <div class="linha-topo">
        <span class="data-hora">${formatarData(b.dataAgendada)} às ${b.horaInicio}</span>
        <span class="badge ${classeStatus(b.status)}">${b.status}</span>
      </div>
      <div class="detalhes">
        ${escapeHtml(b.tipoProcessoNome || "")} · Cavalo: ${escapeHtml(b.placaCavalo || "-")} · Carreta: ${escapeHtml(b.placaCarreta || "-")}<br>
        Motorista: ${escapeHtml(b.motorista || "-")}
        ${b.observacoes ? `<br>Obs: ${escapeHtml(b.observacoes)}` : ""}
      </div>
    `;
    lista.appendChild(div);
  });
}

function classeStatus(status) {
  return {
    "Pendente": "pendente",
    "Aprovado": "aprovado",
    "Recusado": "recusado",
    "Expirado": "expirado",
    "Cancelado": "recusado"
  }[status] || "pendente";
}

function formatarData(dataStr) {
  const [ano, mes, dia] = dataStr.split("-");
  return `${dia}/${mes}/${ano}`;
}

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}
