import { auth } from "./firebase-config.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const form = document.getElementById("recuperar-form");
const errorBox = document.getElementById("recuperar-error");
const sucessoBox = document.getElementById("recuperar-sucesso");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  sucessoBox.textContent = "";

  const email = document.getElementById("email").value.trim();
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) {
    // Não distingue "usuário não encontrado" dos demais erros,
    // para não revelar quais e-mails estão cadastrados no sistema.
    console.error(err);
  } finally {
    sucessoBox.textContent = "Se este e-mail estiver cadastrado, você receberá um link para redefinir a senha em instantes.";
    btn.disabled = false;
    btn.textContent = "Enviar Link de Redefinição";
    form.reset();
  }
});
