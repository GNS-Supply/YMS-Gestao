async function carregarTiposProcesso() {
  const select = document.getElementById("tipoProcesso");
  if (!select) return;

  try {
    // Busca todos os tipos de processo
    const snap = await getDocs(collection(db, "processTypes"));

    select.innerHTML = '<option value="">Selecione o tipo de processo...</option>';

    if (snap.empty) {
      console.warn("Nenhum tipo de processo encontrado na coleção 'processTypes'.");
      return;
    }

    snap.forEach(documento => {
      const dados = documento.data();
      
      // Considera ativo se o campo for true ou se não tiver o campo definido
      if (dados.ativo !== false) {
        const option = document.createElement("option");
        option.value = documento.id;
        option.textContent = dados.nome || dados.titulo || documento.id;
        
        // Guarda o tempo estimado de duração se houver no cadastro
        if (dados.duracaoMinutos) {
          option.dataset.duracao = dados.duracaoMinutos;
        }
        
        select.appendChild(option);
      }
    });
  } catch (err) {
    console.error("Erro ao carregar tipos de processo:", err);
  }
}
