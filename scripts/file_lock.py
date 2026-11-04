"""The small flock API used by Sixfold helpers, on POSIX and Windows.

Windows locks a byte beyond the JSON contents so readers can still inspect the
lock owner's metadata. The OS releases the lock when the file handle closes.
"""
import errno
import os
import time

LOCK_EX, LOCK_NB, LOCK_UN = 2, 4, 8
LOCK_OFFSET = 1 << 30


def flock(stream, operation):
    if os.name != 'nt':
        import fcntl
        return fcntl.flock(stream, operation)
    import msvcrt
    descriptor = stream if isinstance(stream, int) else stream.fileno()
    position = os.lseek(descriptor, 0, os.SEEK_CUR)
    try:
        while True:
            os.lseek(descriptor, LOCK_OFFSET, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK if operation & LOCK_UN else msvcrt.LK_NBLCK, 1)
                return
            except OSError as error:
                if operation & LOCK_UN or error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if operation & LOCK_NB:
                    raise BlockingIOError(error.errno, 'Sixfold helper lock is held') from error
                time.sleep(.05)
    finally:
        os.lseek(descriptor, position, os.SEEK_SET)
