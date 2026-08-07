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
  writeBatch,
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

// Regras e Vagas em Massa
const formRegraSlot = document.getElementById("form-regra-slot");
const regraHoraInicio = document.getElementById("regraHoraInicio");
const regraHoraFim = document.getElementById("regraHoraFim");
const regraCapacidade = document.getElementById("regraCapacidade");
const regraError = document.getElementById("regra-error");
const listaRegras = document.getElementById("lista-regras");

const formGerarMassa = document.getElementById("form-gerar-massa");
const gerarDataInicio = document.getElementById("gerarDataInicio");
const gerarDataFim = document.getElementById("gerarDataFim");
const gerarError = document.getElementById("gerar-error");

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

  // Datas padrão nos campos
  const hojeStr = dataDeHojeStr();
  if (filtroDataGeral) filtroDataGeral.value = hojeStr;
  if (filtroDataSlot) filtroDataSlot.value = hojeStr;
  if (gerarDataInicio) gerarDataInicio.value = hojeStr;
  if (gerarDataFim) {
    const dFim = new Date();
    dFim.setDate(dFim.getDate() + 30);
    gerarDataFim.value = formatarDataISO(dFim);
  }

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

  if (tab !== "hoje" && unsubscribeHoje) {
    unsubscribeHoje();
    unsubscribeHoje = null;
  }

  if (tab === "solicitacoes") carregarSolicitacoes();
  if (tab === "hoje") carregarAgendamentosHoje();
  if (tab === "todos") carregarTodosAgendamentos(filtroDataGeral?.value || dataDeHojeStr());
  if (tab === "slots") {
    carregarRegrasRecorrentes();
    carregarSlotsGerenciamento(filtroDataSlot?.value || dataDeHojeStr());
  }
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
   4. ABA: GESTÃO EM MASSA DE VAGAS E HORÁRIOS (REGRAS RECORRENTES)
   =================================================================== */

// CADASTRAR REGRA RECORRENTE
formRegraSlot?.addEventListener("submit", async (e) => {
  e.preventDefault();
  regraError.textContent = "";

  const diasCheck = Array.from(document.querySelectorAll("input[name='diasSemana']:checked")).map(cb => Number(cb.value));
  const hInicio = regraHoraInicio.value;
  const hFim = regraHoraFim.value;
  const capacidade = Number(regraCapacidade.value);

  if (diasCheck.length === 0) {
    regraError.textContent = "Selecione pelo menos um dia da semana.";
    return;
  }

  const btn = formRegraSlot.querySelector("button[type=submit]");
  btn.disabled = true;

  try {
    await addDoc(collection(db, "timeSlotRules"), {
      diasSemana: diasCheck,
      horaInicio: hInicio,
      horaFim: hFim,
      capacidadeMax: capacidade,
      ativo: true,
      criadoEm: serverTimestamp()
    });

    alert("Regra recorrente salva com sucesso!");
    carregarRegrasRecorrentes();
  } catch (err) {
    console.error("Erro ao salvar regra:", err);
    regraError.textContent = "Erro ao salvar regra recorrente.";
  } finally {
    btn.disabled = false;
  }
});

// LISTAR REGRAS RECORRENTES
async function carregarRegrasRecorrentes() {
  if (!listaRegras) return;
  listaRegras.innerHTML = '<div class="estado-vazio">Carregando regras...</div>';

  try {
    const snap = await getDocs(collection(db, "timeSlotRules"));
    if (snap.empty) {
      listaRegras.innerHTML = '<div class="estado-vazio">Nenhuma regra recorrente cadastrada.</div>';
      return;
    }

    const nomesDias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    listaRegras.innerHTML = "";

    snap.docs.forEach(docSnap => {
      const r = docSnap.data();
      const diasTxt = r.diasSemana.map(d => nomesDias[d]).join(", ");

      const div = document.createElement("div");
      div.className = "item-agendamento";
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      div.style.alignItems = "center";

      div.innerHTML = `
        <div>
          <strong>${r.horaInicio} às ${r.horaFim}</strong> (${r.capacidadeMax} veíq/h)<br>
          <small style="color:var(--texto-suave)">Dias: ${diasTxt}</small>
        </div>
        <button class="btn-excluir-regra" data-id="${docSnap.id}" style="background:var(--vermelho); color:white; border:none; padding:4px 10px; border-radius:4px; font-size:0.8rem; cursor:pointer;">
          Excluir Regra
        </button>
      `;

      listaRegras.appendChild(div);
    });

    document.querySelectorAll(".btn-excluir-regra").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        if (confirm("Deseja remover esta regra recorrente? (Não afetará as vagas já geradas)")) {
          await deleteDoc(doc(db, "timeSlotRules", e.target.dataset.id));
          carregarRegrasRecorrentes();
        }
      });
    });

  } catch (err) {
    console.error(err);
    listaRegras.innerHTML = '<div class="estado-vazio">Erro ao carregar regras.</div>';
  }
}

// GERAR VAGAS EM MASSA
formGerarMassa?.addEventListener("submit", async (e) => {
  e.preventDefault();
  gerarError.textContent = "";

  const dtInicio = new Date(gerarDataInicio.value + "T00:00:00");
  const dtFim = new Date(gerarDataFim.value + "T00:00:00");

  if (dtInicio > dtFim) {
    gerarError.textContent = "A data inicial não pode ser maior que a data final.";
    return;
  }

  const btn = formGerarMassa.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Gerando vagas...";

  try {
    const snapRegras = await getDocs(query(collection(db, "timeSlotRules"), where("ativo", "==", true)));
    if (snapRegras.empty) {
      gerarError.textContent = "Cadastre pelo menos uma regra recorrente antes de gerar em massa.";
      btn.disabled = false;
      btn.textContent = "Gerar Vagas em Lote";
      return;
    }

    const regras = snapRegras.docs.map(d => d.data());
    let totalCriados = 0;
    let curr = new Date(dtInicio);

    // Iteração dia a dia no intervalo fornecido
    while (curr <= dtFim) {
      const diaDaSemana = curr.getDay(); // 0-6
      const dataStr = formatarDataISO(curr);

      // Busca regras aplicáveis a esse dia da semana
      const regrasDia = regras.filter(r => r.diasSemana.includes(diaDaSemana));

      if (regrasDia.length > 0) {
        const batch = writeBatch(db);

        regrasDia.forEach(r => {
          const janelas = gerarJanelasHoraria(r.horaInicio, r.horaFim);

          janelas.forEach(j => {
            const slotId = `${dataStr}_${j.horaInicio.replace(":", "-")}`;
            const refDoc = doc(db, "timeSlots", slotId);

            // Cria/Sobrescreve a vaga mantendo o que já estava configurado
            batch.set(refDoc, {
              data: dataStr,
              horaInicio: j.horaInicio,
              horaFim: j.horaFim,
              capacidadeMax: r.capacidadeMax,
              ocupados: 0,
              ativo: true,
              criadoEm: serverTimestamp()
            }, { merge: true });

            totalCriados++;
          });
        });

        await batch.commit();
      }

      curr.setDate(curr.getDate() + 1);
    }

    alert(`Sucesso! ${totalCriados} horários/vagas foram gerados ou atualizados em massa.`);
    carregarSlotsGerenciamento(filtroDataSlot?.value || dataDeHojeStr());

  } catch (err) {
    console.error("Erro ao gerar vagas em massa:", err);
    gerarError.textContent = "Erro ao processar a geração em lote.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Gerar Vagas em Lote";
  }
});

// AUXILIAR: Quebra janelas de 1 em 1 hora
function gerarJanelasHoraria(hInicio, hFim) {
  const janelas = [];
  let [hIni, mIni] = hInicio.split(":").map(Number);
  let [hEnd, mEnd] = hFim.split(":").map(Number);

  if (hEnd === 0 && mEnd === 0) hEnd = 24; // Trata meia-noite (00:00) como hora 24

  let atual = hIni;
  while (atual < hEnd) {
    let proximo = atual + 1;
    let strInicio = `${String(atual).padStart(2, "0")}:00`;
    let strFim = `${String(proximo === 24 ? 0 : proximo).padStart(2, "0")}:00`;

    janelas.push({ horaInicio: strInicio, horaFim: strFim });
    atual++;
  }

  return janelas;
}

// EDITAR/LISTAR SLOTS DA DATA SELECIONADA (EDIÇÃO PONTUAL)
async function carregarSlotsGerenciamento(dataStr) {
  if (!listaSlots) return;
  listaSlots.innerHTML = '<div class="estado-vazio">Carregando horários da data...</div>';

  try {
    const qSlots = query(collection(db, "timeSlots"), where("data", "==", dataStr));
    const snap = await getDocs(qSlots);

    if (snap.empty) {
      listaSlots.innerHTML = `<div class="estado-vazio">Nenhum horário gerado para ${formatarData(dataStr)}.</div>`;
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
        <div class="detalhes" style="margin-top:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            Alterar Vagas: 
            <input type="number" class="input-cap-slot" data-id="${slot.id}" value="${slot.capacidadeMax}" min="0" style="width:60px; padding:2px 6px;">
            <button class="btn-salvar-cap-slot" data-id="${slot.id}" style="background:var(--azul); color:white; border:none; padding:4px 8px; border-radius:4px; font-size:0.8rem; cursor:pointer;">Salvar</button>
          </div>
          <button class="btn-excluir-slot" data-id="${slot.id}" style="background:var(--vermelho); color:white; border:none; padding:4px 10px; border-radius:4px; font-size:0.8rem; cursor:pointer;">
            Remover Vaga Desta Data
          </button>
        </div>
      `;

      listaSlots.appendChild(div);
    });

    // Salvar capacidade alterada pontualmente
    document.querySelectorAll(".btn-salvar-cap-slot").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idSlot = e.target.dataset.id;
        const novaCap = Number(document.querySelector(`.input-cap-slot[data-id="${idSlot}"]`).value);

        try {
          await updateDoc(doc(db, "timeSlots", idSlot), { capacidadeMax: novaCap });
          alert("Capacidade da vaga atualizada para esta data!");
          carregarSlotsGerenciamento(dataStr);
        } catch (err) {
          console.error(err);
          alert("Erro ao alterar vaga.");
        }
      });
    });

    // Remover vaga pontualmente daquela data
    document.querySelectorAll(".btn-excluir-slot").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idSlot = e.target.dataset.id;
        if (confirm("Remover esta vaga para esta data específica?")) {
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
  return formatarDataISO(new Date());
}

function formatarDataISO(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
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
