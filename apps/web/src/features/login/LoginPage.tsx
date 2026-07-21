/**
 * LoginPage — S0 composition. It owns exactly the two things a page owns here:
 * the data machine (useLogin, EP-02) and navigation (a clean login lands at '/'
 * — the app shell's guarded routes take over from there). Everything visual is
 * delegated to the pure LoginView. There is NO app shell on this route (pre-auth).
 */
import { useNavigate } from 'react-router-dom';

import { LoginView } from './LoginView';
import { useLogin } from './useLogin';

export default function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const login = useLogin({ onSuccess: () => navigate('/') });

  return (
    <LoginView
      secret={login.secret}
      status={login.status}
      errorKind={login.errorKind}
      cooldown={login.cooldown}
      loginDisabled={login.loginDisabled}
      onSecretChange={login.setSecret}
      onSubmit={login.submit}
    />
  );
}
