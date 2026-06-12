import { createContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase.js';

console.log('[auth] AuthContext module loaded');
export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    console.log('[auth] AuthProvider mounted');
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        console.log('[auth] signed IN', firebaseUser.email);
      } else {
        console.log('[auth] signed OUT / no user');
      }
      setUser(firebaseUser);
      setLoading(false);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  async function login() {
    setAuthError(null);
    console.log('[auth] login() — opening popup');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      console.log('[auth] popup sign-in succeeded', result.user.email);
    } catch (e) {
      console.error('[auth] popup sign-in failed:', e.code, e.message);
      setAuthError(`Sign-in failed: ${e.message}`);
    }
  }

  async function logout() {
    console.log('[auth] logout()');
    try {
      await signOut(auth);
      console.log('[auth] signed out');
    } catch (e) {
      console.error('[auth] signOut failed:', e.message);
    }
  }

  return (
    <AuthContext.Provider value={{ user, uid: user?.uid ?? null, loading, login, logout, authError }}>
      {children}
    </AuthContext.Provider>
  );
}
