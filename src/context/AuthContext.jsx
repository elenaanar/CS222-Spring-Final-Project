import { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider } from '../firebase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        console.log(`[auth] Logged in: uid=${firebaseUser.uid} displayName=${firebaseUser.displayName} email=${firebaseUser.email}`);
      } else {
        console.log('[auth] Logged out');
      }
    });
  }, []);

  async function login() {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') {
        console.error('[auth] Login failed:', e.message);
      }
    }
  }

  async function logout() {
    try {
      await signOut(auth);
    } catch (e) {
      console.error('[auth] Logout failed:', e.message);
    }
  }

  // uid shortcut — null when signed out, used later for Firestore paths
  const uid = user?.uid ?? null;

  return (
    <AuthContext.Provider value={{ user, uid, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
