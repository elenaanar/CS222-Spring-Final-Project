import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDtie-LQ7LCnu7hbl0KI-2JUgrxURJ5hvg',
  authDomain: 'cs222-final-project-963b2.firebaseapp.com',
  projectId: 'cs222-final-project-963b2',
  storageBucket: 'cs222-final-project-963b2.firebasestorage.app',
  messagingSenderId: '6752835235',
  appId: '1:6752835235:web:4b8d4ca4402cecfffe1116'
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
