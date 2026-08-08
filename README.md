# Sistema de Agendamento de Pátio

Sistema web + mobile para agendamento de janelas de carga/descarga, com controle
de capacidade em tempo real e aprovação por perfil.

## Stack

| Camada              | Tecnologia                                 |
|---------------------|---------------------------------------------|
| Front-end Web        | HTML + CSS + JavaScript puro (sem build)    |
| Front-end Mobile      | Flutter                                     |
| Banco de dados / Auth | Firebase (Firestore + Authentication)       |
| Backend / Cron / Segredos | Cloudflare Workers                     |
| Hospedagem Web        | Netlify (deploy automático via GitHub)      |
| Versionamento / CI     | GitHub + GitHub Actions                    |

## Estrutura do repositório

```
patio-agendamento/
├── web/                     # App web (HTML/CSS/JS puro)
│   ├── index.html           # Login
│   ├── css/style.css
│   ├── js/firebase-config.js
│   ├── js/auth.js
│   ├── transportadora/      # Telas do perfil Transportadora
│   ├── logistica/           # Telas do perfil Logística
│   └── admin/                # Telas do perfil Admin Master
├── mobile/                  # App Flutter (transportadora/motorista)
├── cloudflare-worker/       # API + Cron Job de expiração + segredos
├── firestore.rules          # Regras de segurança
├── firestore.indexes.json   # Índices compostos necessários
└── README.md
```

## Modelo de dados (Firestore)

### `users/{uid}`
```json
{
  "nome": "string",
  "email": "string",
  "tipo": 1,            // 1=Transportadora, 2=Logística, 3=Admin
  "empresa": "string",  // preenchido se tipo=1
  "criadoEm": "timestamp"
}
```

### `processTypes/{id}`
```json
{ "nome": "Carga Geral", "ativo": true }
```

### Disponibilidade de horários (sem geração em massa no calendário)

Nenhuma vaga futura precisa ser "gerada" previamente. A disponibilidade de
qualquer data (mesmo daqui a 2 anos) é calculada dinamicamente no momento da
consulta, combinando 3 coleções em ordem de prioridade (a de baixo sobrescreve
a de cima), implementado em `web/js/disponibilidade.js`:

**1) `timeSlotRules/{id}` — Regra Padrão de Atendimento (recorrente)**
```json
{
  "diasSemana": [1,2,3,4,5],     // 0=domingo ... 6=sábado
  "horaInicio": "06:00",
  "horaFim": "00:00",             // pode atravessar a meia-noite
  "capacidadePorHora": 2,
  "ativo": true
}
```
Define o horário de funcionamento padrão do pátio e a capacidade por hora,
para qualquer data futura que caia naqueles dias da semana.

**2) `timeSlotExceptions/{id}` — Exceções recorrentes (têm prioridade sobre a regra padrão)**
```json
{
  "diasSemana": [0],              // ex: domingo
  "horaInicio": "00:00",
  "horaFim": "23:59",
  "capacidadePorHora": 0,         // 0 = sem atendimento nesse intervalo
  "ativo": true
}
```
Usadas para bloquear um período recorrente (ex: domingo sem atendimento) ou
reduzir a capacidade em um intervalo específico (ex: seg a sex, 11:00-14:00,
1 veículo/hora no horário de almoço). Se `capacidadePorHora` for maior que 0,
o valor sobrescreve a capacidade da regra padrão apenas naquele dia/horário.

**3) `timeSlots/{data}_{hora}` — Ajuste manual pontual por data (prioridade máxima)**
```json
{
  "data": "2026-08-10",
  "horaInicio": "08:00",
  "horaFim": "09:00",
  "capacidadeMax": 3,
  "ativo": true,
  "ocupados": 1
}
```
Documento **opcional**, criado sob demanda:
- É criado automaticamente ("lazy") pela transação de agendamento, na primeira
  reserva feita para aquele horário/data — é onde a ocupação real (`ocupados`)
  fica registrada, garantindo atomicidade contra concorrência.
- Também pode ser criado/editado manualmente pela Logística/Admin na aba
  "Vagas & Horários" para fechar, reabrir ou mudar a capacidade só daquele dia
  específico (sem afetar a regra padrão nem outras datas), ou para liberar um
  horário fora do padrão pontualmente.

### `bookings/{id}`
```json
{
  "transportadoraId": "uid",
  "empresa": "string",
  "dataAgendada": "2026-08-10",
  "horaInicio": "08:00",
  "tipoProcessoId": "id",
  "placaCavalo": "string",
  "placaCarreta": "string",
  "motorista": "string",
  "observacoes": "string",
  "status": "Pendente",   // Pendente | Aprovado | Recusado | Expirado | Cancelado
  "criadoEm": "timestamp",
  "atualizadoEm": "timestamp"
}
```

### `auditLogs/{id}`
```json
{
  "bookingId": "id",
  "usuarioId": "uid",
  "acao": "Solicitou",   // Solicitou | Aprovou | Recusou | Expirou | Cancelou
  "dataHora": "timestamp"
}
```

## Como evitar conflito de vagas (2 pessoas agendando ao mesmo tempo)

A criação de um agendamento **não é um simples `add()`** — é uma
**Firestore Transaction** sobre o documento `timeSlots/{data}_{hora}`:

1. O cliente já sabe, a partir de `disponibilidade.js`, qual a capacidade
   calculada (regra padrão ou exceção) para aquele horário/data.
2. Dentro da transação: se o documento em `timeSlots` ainda não existir
   (data futura nunca reservada antes), ele é **criado na hora** usando essa
   capacidade calculada, com `ocupados = 1`. Se já existir, o cliente lê o
   `ocupados` atual e só confirma a escrita se ainda houver vaga.
3. O Firestore garante atomicidade: se duas transportadoras tentarem a
   última vaga ao mesmo tempo, apenas uma transaction vence — a outra recebe
   erro e o front-end informa "vaga acabou de ser preenchida, escolha outro
   horário".

Isso elimina a necessidade de gerar vagas em massa no calendário: o
documento de controle de ocupação só passa a existir quando (a) alguém
reserva aquele horário pela primeira vez, ou (b) a Logística/Admin cria um
ajuste manual pontual para aquela data.

## Próximos passos de implementação

1. ✅ Estrutura + regras de segurança + modelo de dados
2. ⬜ Tela de login web (Firebase Auth)
3. ⬜ Dashboard Transportadora (form de agendamento + "meus agendamentos")
4. ⬜ Dashboard Logística (aprovar/recusar + configurar vagas)
5. ⬜ Painel Admin Master
6. ⬜ Cloudflare Worker: Cron de expiração automática
7. ⬜ App Flutter (mobile)
8. ⬜ Deploy Netlify + GitHub Actions
