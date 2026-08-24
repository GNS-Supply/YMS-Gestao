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
