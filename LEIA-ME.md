# Alterações no YMS-Gestao

Não tenho permissão de escrita no seu GitHub, então aqui estão os 4 arquivos
já modificados + um patch (`mudancas.patch`) para aplicar via
`git apply mudancas.patch` na raiz do repo, se preferir.

## Como aplicar
Baixe os 4 arquivos e substitua os originais no seu repositório local, ou:
```
cd YMS-Gestao
git apply mudancas.patch
git add -A
git commit -m "Exigencia de NF por tipo de processo + suporte a multi-planta (matriz/filiais)"
git push
```

## 1) Exigência de Nota Fiscal por Tipo de Processo
- Ao cadastrar um Tipo de Processo (aba Tipos de Processo), agora existe o
  campo "Exigir Nota Fiscal": Não definido / Somente Entrada / Somente
  Saída / Entrada e Saída.
- Os 3 tipos já existentes (Carga, Descarga, Carga & Descarga) são migrados
  automaticamente para "Não definido" na primeira vez que a aba é aberta —
  o comportamento deles continua IDÊNTICO ao de hoje (pede NF só na saída)
  até você decidir mudar.
- A tabela da aba permite editar a exigência de qualquer tipo a qualquer
  momento (select inline, salva na hora).
- Check-in, Check-out e Encaixe (entrada expressa) agora mostram/exigem o
  campo de NF dinamicamente, de acordo com o tipo de processo do
  agendamento. A validação também roda dentro da transação em
  `patioCore.js`, então fica protegida mesmo se alguém pular a interface.

## 2) Plantas / Filiais (multi-unidade em paralelo)
- Nova aba **"Plantas / Filiais"** no Painel Admin (só tipo 3 vê e mexe):
  cadastrar planta, ativar/desativar. A unidade atual já existe
  implicitamente como planta "Matriz" — nada precisa ser migrado.
- Na tabela de usuários do Admin, cada usuário (Transportadora, Logística,
  Admin) agora tem uma coluna "Planta". Para o pessoal de Portaria/
  Logística, essa é a planta em que ele vai operar: o painel dele passa a
  mostrar e criar dados (Tipos de Processo, Vagas & Horários, Regras,
  Bookings, Portaria/Pátio) exclusivamente dentro dessa planta — o pátio
  de cada planta fica isolado do das outras.
- No Painel da Transportadora, se houver mais de uma planta ativa
  cadastrada, aparece um seletor "Planta / Filial" no formulário de
  agendamento (fica oculto automaticamente enquanto só existir a Matriz).
  Trocar a planta recarrega os tipos de processo e horários disponíveis
  daquela unidade.
- Tudo foi feito para não exigir migração de dados: qualquer documento
  antigo sem o campo `plantaId` é tratado como pertencente à Matriz.

## 3) Novo tipo de usuário: Portaria (tipo 4)
- Assim como Logística/Admin, esse tipo **não existe na tela de cadastro**
  — quem se cadastra como "interno" continua caindo em
  `status: "pendente_aprovacao"`, e é o Admin quem decide o tipo na
  aprovação (aba Aprovações Pendentes ou Gestão de Usuários), agora com a
  opção "Portaria (4)" nos dois lugares.
- Usuário tipo 4 faz login normalmente e cai no mesmo
  `logistica-dashboard.html` de Logística/Admin (reaproveita toda a
  lógica de planta, check-in/check-out/encaixe já pronta), mas com o menu
  lateral restrito a 3 abas: **Painel do Dia**, **Portaria** e **KPIs /
  Indicadores** (usei essa como "Dashboard" — me avise se você tinha outra
  aba em mente). Solicitações, Todos os Agend., Novo Agendamento,
  Horários & Exceções, Gestão de Vagas e Tipos de Processo ficam ocultos.
- Essa restrição hoje é só de interface (esconde os botões e bloqueia
  navegação por `?tab=` para uma aba não liberada). Ela NÃO impede um
  usuário tipo 4 de, por exemplo, chamar `getDocs(collection(db,
  "processTypes"))` diretamente pelo console do navegador — isso só fica
  de fato travado com as Firestore Rules, que ficaram combinado de
  ajustarmos a seguir.

## Pontos de atenção antes de subir para produção
- **Regras de segurança do Firestore** (não estão neste repo/patch): se
  você tiver `firestore.rules` restringindo por perfil, vale conferir se
  alguma regra precisa saber sobre `plantaId` (por exemplo, impedir que um
  usuário de Logística da Filial escreva em `bookings` da Matriz). Hoje o
  isolamento é feito no cliente (JS); reforçar isso nas regras do servidor
  é recomendado antes de operar duas plantas de verdade com equipes
  diferentes.
- Teste local recomendado: criar 1 planta filial de teste, um usuário
  Logística vinculado a ela, e confirmar que os dados da Matriz não
  aparecem para esse usuário (e vice-versa).

## 4) Firestore Rules atualizadas (`firestore.rules`)

Reescrevi o arquivo que você me mandou incorporando as 3 mudanças dos
itens 1-3 acima. Nada do que já existia foi removido — só adicionado ou
afrouxado no ponto exato onde era necessário:

- **NF por tipo de processo**: `checkInValido`/`checkOutValido` agora
  consultam `processTypes/{id}.exigenciaNF` (com `get()`) e só exigem o
  número da NF quando o tipo de processo pede — mesma lógica de
  `exigeNFNaEntrada`/`exigeNFNaSaida` do `patioCore.js`. Antes, o
  check-out sempre exigia NF preenchida, para qualquer tipo.
- **Multi-planta**: nova seção `match /plantas/{id}` (leitura para
  qualquer aprovado, escrita só Admin). Toda coleção que ganhou o campo
  opcional `plantaId` (processTypes, timeSlotRules, timeSlotExceptions,
  timeSlots, recorrencias, bookings, users) agora aceita esse campo
  quando presente — sem exigir, então documentos antigos continuam
  válidos sem migração.
- **Tipo 4 "Portaria"**: adicionada a função `souPortaria()` e:
  - `users`: Admin agora pode atribuir tipo `4` e o campo `plantaId`.
  - `bookings`: Portaria pode **ler** todos os agendamentos, **criar**
    somente Encaixe (`tipoAgendamento == 'Portaria/Encaixe'`, nunca um
    agendamento "Operacional" completo) e **atualizar** apenas para
    check-in / check-out / no-show — nunca para Aprovar/Recusar uma
    solicitação (a regra só deixa a `aprovacaoStatus` ficar como está ou
    resolver `PENDENTE → SEM_RESPOSTA`, que é o que o check-in faz
    sozinho) nem para editar campos como `horaEntrada`/`horaSaida`
    (edição manual, aba oculta pra esse perfil).
  - `timeSlots`: Portaria só pode **decrementar** `ocupados` em 1 (é o
    que acontece ao marcar No-Show) — não pode criar, fechar ou alterar
    capacidade de vaga.
  - Portaria **não** ganhou nenhum acesso de escrita a `processTypes`,
    `timeSlotRules`, `timeSlotExceptions` ou `recorrencias` — essas
    continuam exclusivas de Logística/Admin, reforçando no servidor o
    que já estava escondido na interface.

### Como aplicar
```
cd YMS-Gestao
firebase deploy --only firestore:rules
```
(ou cole o conteúdo de `firestore.rules` direto no Console do Firebase,
em Firestore Database → Regras).

### Não deixei de revisar, mas vale você confirmar
- **`config/capacidadeGlobal`**: se você ainda não tem esse documento
  criado manualmente, o fallback de 200 veículos/hora por horário segue
  valendo (comentário original no arquivo já falava disso).
- Testei o arquivo por balanceamento de chaves/parênteses e revisei
  campo a campo contra o que o `patioCore.js`/telas realmente enviam ao
  Firestore, mas não tive como rodar o Firestore Emulator aqui (bloqueado
  pela rede sandbox) — o ideal é você rodar
  `firebase emulators:start --only firestore` localmente (ou publicar
  primeiro num projeto de teste) antes de ir pra produção.

## 5) Admin com acesso total a todas as plantas (`logistica-dashboard.html`)

O Admin agora pode ver e operar qualquer planta cadastrada, sem deixar
de ter uma planta padrão (a que está salva no cadastro dele). Sempre que
ele estiver fora dela, aparece um aviso bem visível.

- **Seletor de planta no topo**: só aparece para o Admin (tipo 3). Para
  Logística/Portaria, continua sendo só o texto "Planta: X" de sempre —
  esses perfis seguem presos à planta atribuída pelo Admin, sem opção de
  trocar.
- **Ao trocar de planta no seletor**: Tipos de Processo, Agendamentos
  (Painel do Dia, Portaria, Todos, KPIs), Horários & Exceções e
  Recorrências recarregam automaticamente para a nova planta — e a
  próxima criação/edição feita pelo Admin passa a gravar `plantaId` da
  planta selecionada. Gestão de Vagas é feita por busca manual, então
  só limpei o resultado antigo (o botão "Buscar Vagas" já usa a planta
  atual quando clicado de novo).
- **Aviso em destaque**: quando `planta selecionada ≠ planta padrão do
  Admin`, aparece uma faixa laranja fixa no topo da tela ("Você está
  fora da sua planta padrão — visualizando e editando [Nome]. Confira
  antes de criar ou alterar algo.") e o próprio seletor fica destacado
  em laranja — pensado pra ser difícil de não notar antes de confirmar
  qualquer ação.
- Nas Firestore Rules, isso não muda nada: o Admin (`souAdmin()`) já
  tinha acesso irrestrito a todas as plantas desde a rewrite anterior —
  essa mudança é só de interface/experiência, não de permissão.

## 6) "Meus Agendamentos" reorganizado (`transportadora-dashboard.html`)

A tela ganhou os mesmos recursos de organização/consulta do "Painel do
Dia" da Logística, adaptados para a Transportadora:

- **Atalhos rápidos de período**: Todos / Hoje / Próximos / Histórico
  (histórico = data já passada). Um clique já filtra a lista, sem
  precisar escolher datas manualmente.
- **Período customizado**: dois campos de data (de/até) — ao usar,
  substitui o atalho rápido automaticamente (os dois nunca ficam
  combinados de forma confusa).
- **Filtro por Tipo de Processo**: select com os tipos ativos.
- **Filtro por Status da Solicitação**: Pendente/Aguardando, Aprovado
  (inclui Em Pátio/Concluído), Recusado (inclui Cancelado/No-Show) ou
  Expirado.
- **Busca por motorista/placa**: já existia, mantida como estava.
- **Ordenar por**: além das opções já existentes, adicionei "Tipo de
  Processo (A-Z)".
- **Contador** (ex: "8 de 23 agendamento(s)") e botão **Limpar
  filtros**.
- Ao criar um novo agendamento, a tela agora limpa os filtros
  automaticamente antes de destacar o item recém-criado — assim um
  filtro esquecido de uma consulta anterior nunca esconde a
  confirmação do que acabou de ser agendado.

## 7) Correções de interface (`logistica-dashboard.html`, `style.css`)

- **Menu lateral "andando" com o scroll**: o menu (`.sidebar-erp`) usa
  `position: sticky` com um deslocamento do topo fixo em 60px — quando
  a topbar ficava mais alta que isso (ex: com o seletor de planta do
  Admin), o menu deixava de caber no espaço calculado e passava a se
  mover junto com a rolagem em vez de ficar fixo. Troquei o valor fixo
  por uma variável CSS (`--topbar-altura`) medida de verdade em JS a
  partir da altura real da topbar (via `ResizeObserver`, então também
  se ajusta sozinho caso o conteúdo da topbar mude depois). Sem
  impacto nas outras telas que usam o mesmo menu (`admin-dashboard.html`)
  — lá a variável simplesmente cai no valor padrão de 60px, idêntico ao
  comportamento anterior.
- **Contraste do seletor de planta**: a lista suspensa (`<option>`)
  estava sem estilo próprio e herdava o texto branco do controle
  fechado, mas com fundo claro padrão do navegador — texto branco em
  fundo claro, ilegível. Agora as opções têm fundo escuro fixo e texto
  branco, com bom contraste em qualquer navegador.

## 8) Tipo de Veículo (`patioCore.js`, `transportadora-dashboard.html`, `logistica-dashboard.html`, `firestore.rules`)

Todo agendamento — feito pela Transportadora, pela Logística/Admin
("Novo Agendamento") ou pela Portaria (Encaixe) — agora pergunta o
**Tipo de Veículo**: Moto, Carro, VUC, 3/4, Toco, Truck, Carreta ou
Bitruck. Campo obrigatório nos três fluxos.

- **Confirmação no Check-in**: a tela de Check-in vem pré-preenchida
  com o tipo declarado no agendamento, mas a Portaria pode trocar caso
  o veículo físico seja outro. Se ela mudar, isso conta como uma
  **divergência de cadastro** — mesma lógica já usada para placa e
  motorista — e o dado "de verdade" (o confirmado no check-in)
  prevalece sobre o declarado para fins de indicador.
- **Entrada por Encaixe**: como já nasce "Em Pátio" sem passar por um
  check-in separado, o tipo informado no formulário de Encaixe já vale
  como confirmado.
- **Indicador "Tipos de Veículo Mais Recorrentes"** (aba KPIs): barra
  horizontal por tipo, ordenada do mais para o menos frequente, com
  quantidade e percentual — usa o mesmo filtro de período/empresa já
  existente no painel de KPIs.
- **Indicador "Movimentação por Dia da Semana × Horário"** (aba KPIs):
  um heatmap (linhas = horário, colunas = dia da semana, intensidade de
  cor = volume) com um seletor de **Tipo de Processo** (ou "Todos"),
  além de duas listas — "Horários de Maior Movimento" e "Horários de
  Menor Movimento" — com as 5 combinações dia+horário mais e menos
  movimentadas. Usa o horário AGENDADO (não o do check-in), pra refletir
  a demanda que o pátio precisa se preparar para atender.
- Bookings antigos, feitos antes deste recurso existir, ficam sem
  `tipoVeiculo` — eles entram como "sem informação" no indicador de
  distribuição (mostrado à parte, sem quebrar a contagem) e simplesmente
  não aparecem no heatmap de movimentação (que também não depende desse
  campo).
- **Firestore Rules**: `tipoVeiculo` passou a ser exigido (dentro da
  lista de 8 tipos) em toda criação de agendamento; no check-in, é
  aceito também como ausente/nulo, para não travar o check-in de
  bookings antigos sem esse campo.

## 9) Faixa âmbar no cabeçalho (`style.css`)

Adicionada a linha de destaque logo abaixo da topbar escura, no mesmo
tom "Âmbar de Sinalização" que a paleta do sistema já usa em avisos e
badges (`--laranja: #E8A33D` — já existia, só não estava aplicada aqui).
Como está em `style.css`, vale para todas as telas automaticamente
(Logística, Admin, Transportadora, Cadastro, Login).

Também ajustei o valor padrão (fallback) usado pelo menu lateral
sticky do item 7 — de 60px para 63px — pra já contar com os 3px a mais
que essa borda adiciona à altura real da topbar, sem reabrir o bug do
menu "andando" com o scroll em telas que não medem a altura
dinamicamente (só `logistica-dashboard.html` faz essa medição via JS).
