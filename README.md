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

### `timeSlots/{id}`
```json
{
  "horaInicio": "08:00",
  "horaFim": "09:00",
  "limiteVeiculos": 5,
  "diasSemana": [1,2,3,4,5],   // 0=domingo ... 6=sábado
  "ativo": true
}
```

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
**Firestore Transaction**: o cliente lê a contagem atual de `bookings`
com `status in [Pendente, Aprovado]` para aquele `timeSlot` + `data`,
e só confirma a escrita se ainda houver vaga. O Firestore garante
atomicidade: se duas transportadoras tentarem a última vaga ao mesmo
tempo, apenas uma transaction vence — a outra recebe erro e o
front-end informa "vaga acabou de ser preenchida, escolha outro horário".

## Próximos passos de implementação

1. ✅ Estrutura + regras de segurança + modelo de dados
2. ⬜ Tela de login web (Firebase Auth)
3. ⬜ Dashboard Transportadora (form de agendamento + "meus agendamentos")
4. ⬜ Dashboard Logística (aprovar/recusar + configurar vagas)
5. ⬜ Painel Admin Master
6. ⬜ Cloudflare Worker: Cron de expiração automática
7. ⬜ App Flutter (mobile)
8. ⬜ Deploy Netlify + GitHub Actions
