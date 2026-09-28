// kite-launch: runs its arguments as a child that is responsible for itself.
//
// macOS attributes privacy permissions (TCC), Accessibility included, to the
// "responsible" process, which a child inherits from whatever started it. A
// dev Electron spawned from `npm run dev` would otherwise have its grant land
// on the terminal, or on whatever tool ran the terminal command. Disclaiming
// responsibility at spawn makes the child its own responsible process, so the
// grant goes to Electron.app, whose signature is stable for an Electron
// version.
//
// responsibility_spawnattrs_setdisclaim is private API, so it is looked up
// with dlsym: if a macOS release drops it, this still builds and runs, and
// spawns without disclaiming after one warning line on stderr.
//
// stdin, stdout and stderr are inherited. SIGINT and SIGTERM are forwarded to
// the child, and this exits with the child's status, or re-raises the signal
// that ended it.

#include <dlfcn.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

typedef int (*disclaim_fn)(posix_spawnattr_t *, int);

static volatile sig_atomic_t child_pid = 0;

static void forward(int sig) {
  if (child_pid > 0) kill((pid_t)child_pid, sig);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: kite-launch program [argument ...]\n");
    return 64;
  }

  // Block the forwarded signals until the child's pid is known, so one that
  // arrives during the spawn is held and forwarded rather than lost.
  sigset_t forwarded, original;
  sigemptyset(&forwarded);
  sigaddset(&forwarded, SIGINT);
  sigaddset(&forwarded, SIGTERM);
  sigprocmask(SIG_BLOCK, &forwarded, &original);

  posix_spawnattr_t attr;
  int rc = posix_spawnattr_init(&attr);
  if (rc != 0) {
    fprintf(stderr, "kite-launch: posix_spawnattr_init: %s\n", strerror(rc));
    return 71;
  }
  // The child starts with this process's original mask and default handlers
  // for the forwarded signals, as a direct spawn would.
  posix_spawnattr_setsigmask(&attr, &original);
  posix_spawnattr_setsigdefault(&attr, &forwarded);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

  disclaim_fn disclaim =
      (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (disclaim == NULL || disclaim(&attr, 1) != 0)
    fprintf(stderr,
            "kite-launch: can't disclaim responsibility; macOS will attribute "
            "permissions to the app that started this one\n");

  pid_t pid;
  rc = posix_spawnp(&pid, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    fprintf(stderr, "kite-launch: %s: %s\n", argv[1], strerror(rc));
    return rc == ENOENT ? 127 : 126;
  }
  child_pid = pid;

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  sigprocmask(SIG_SETMASK, &original, NULL);

  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      fprintf(stderr, "kite-launch: waitpid: %s\n", strerror(errno));
      return 71;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    // End the same way the child did, so the caller sees the same signal.
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    kill(getpid(), sig);
    return 128 + sig;
  }
  return 71;
}
