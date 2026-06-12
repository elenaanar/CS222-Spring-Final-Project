import { createContext, useContext, useEffect, useState } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithRedirect,
  signOut
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    // Consume the redirect result when the page loads after a Google sign-in redirect.
    // Errors here surface as visible messages rather than silent failures.
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          console.log(`[auth] Redirect sign-in complete: uid=${result.user.uid} displayName=${result.user.displayName}`);
        }
      })
      .catch((e) => {
        console.error('[auth] Redirect result error:', e.code, e.message);
        setAuthError(`Sign-in failed (${e.code}). Check Firebase authorized domains.`);
      });

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
    setAuthError(null);
    try {
      // signInWithRedirect navigates the full page to Google — avoids popup/cookie issues in dev.
      await signInWithRedirect(auth, googleProvider);
    } catch (e) {
      console.error('[auth] Login failed:', e.code, e.message);
      setAuthError(`Sign-in failed: ${e.message}`);
    }
  }

  async function logout() {
    try {
      await signOut(auth);
    } catch (e) {
      console.error('[auth] Logout failed:', e.message);
    }
  }

  const uid = user?.uid ?? null;

  return (
    <AuthContext.Provider value={{ user, uid, loading, login, logout, authError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
