// =====================================================================
// CONFIGURAÇÃO DO FIREBASE
// Substitua os valores abaixo pelos do SEU projeto:
// Console Firebase > Configurações do Projeto > Seus Apps > Config
//
// IMPORTANTE: essas chaves são PÚBLICAS por natureza (ficam visíveis no
// navegador). A segurança real vem das Firestore Security Rules
// (arquivo firestore.rules), não do sigilo dessas chaves.
// =====================================================================

// Sem etapa de build no front-end, então TODOS os módulos do SDK
// precisam vir do mesmo CDN (não misturar com "firebase/app" do npm).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAD93H9nQu9JOdpvjunsR_sB_noBQEeMfs",
  authDomain: "yms-gestao.firebaseapp.com",
  projectId: "yms-gestao",
  storageBucket: "yms-gestao.firebasestorage.app",
  messagingSenderId: "721351714653",
  appId: "1:721351714653:web:b429986b886b009461aab4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
