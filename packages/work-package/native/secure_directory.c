#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef __APPLE__
#error "cortex_secure_fs requires macOS"
#endif

static const char *errno_name(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EPERM: return "EPERM";
    case EXDEV: return "EXDEV";
    case EWOULDBLOCK: return "EWOULDBLOCK";
    default: return "NATIVE_FILESYSTEM_ERROR";
  }
}

static napi_value throw_code(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}

static napi_value throw_errno_value(napi_env env, int value) {
  const char *code = errno_name(value);
  napi_throw_error(env, code, code);
  return NULL;
}

static bool get_arguments(
    napi_env env,
    napi_callback_info info,
    size_t expected,
    napi_value *arguments) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != expected) {
    throw_code(env, "NATIVE_ARGUMENT_INVALID");
    return false;
  }
  return true;
}

static bool get_fd(napi_env env, napi_value value, int *result) {
  int32_t descriptor;
  if (napi_get_value_int32(env, value, &descriptor) != napi_ok || descriptor < 0) {
    throw_code(env, "NATIVE_ARGUMENT_INVALID");
    return false;
  }
  *result = descriptor;
  return true;
}

static char *get_string(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0) {
    throw_code(env, "NATIVE_ARGUMENT_INVALID");
    return NULL;
  }
  char *result = malloc(length + 1);
  if (result == NULL) {
    throw_errno_value(env, ENOMEM);
    return NULL;
  }
  size_t copied;
  if (napi_get_value_string_utf8(env, value, result, length + 1, &copied) != napi_ok ||
      copied != length || strlen(result) != length) {
    free(result);
    throw_code(env, "NATIVE_ARGUMENT_INVALID");
    return NULL;
  }
  return result;
}

static bool valid_leaf(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 &&
         strchr(name, '/') == NULL;
}

static napi_value fd_value(napi_env env, int descriptor) {
  napi_value result;
  if (napi_create_int32(env, descriptor, &result) != napi_ok) {
    close(descriptor);
    return throw_code(env, "NATIVE_RESULT_FAILED");
  }
  return result;
}

static napi_value open_secure_directory(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!get_arguments(env, info, 1, arguments)) return NULL;
  char *path = get_string(env, arguments[0]);
  if (path == NULL) return NULL;
  size_t length = strlen(path);
  if (path[0] != '/' || (length > 1 && path[length - 1] == '/')) {
    free(path);
    return throw_code(env, "EINVAL");
  }
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) {
    int error = errno;
    free(path);
    return throw_errno_value(env, error);
  }
  if (length == 1) {
    free(path);
    return fd_value(env, current);
  }
  char *cursor = path + 1;
  while (*cursor != '\0') {
    char *separator = strchr(cursor, '/');
    if (separator != NULL) *separator = '\0';
    if (!valid_leaf(cursor)) {
      close(current);
      free(path);
      return throw_code(env, "EINVAL");
    }
    int next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      int error = errno;
      close(current);
      free(path);
      return throw_errno_value(env, error);
    }
    close(current);
    current = next;
    if (separator == NULL) break;
    cursor = separator + 1;
  }
  free(path);
  return fd_value(env, current);
}

static napi_value open_directory_at(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!get_arguments(env, info, 2, arguments)) return NULL;
  int parent;
  if (!get_fd(env, arguments[0], &parent)) return NULL;
  char *name = get_string(env, arguments[1]);
  if (name == NULL) return NULL;
  if (!valid_leaf(name)) {
    free(name);
    return throw_code(env, "EINVAL");
  }
  int result = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int error = errno;
  free(name);
  return result < 0 ? throw_errno_value(env, error) : fd_value(env, result);
}

static napi_value open_file_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  if (!get_arguments(env, info, 4, arguments)) return NULL;
  int parent;
  if (!get_fd(env, arguments[0], &parent)) return NULL;
  char *name = get_string(env, arguments[1]);
  char *mode_name = get_string(env, arguments[2]);
  uint32_t mode;
  if (name == NULL || mode_name == NULL ||
      napi_get_value_uint32(env, arguments[3], &mode) != napi_ok || mode > 0777) {
    free(name);
    free(mode_name);
    return throw_code(env, "NATIVE_ARGUMENT_INVALID");
  }
  if (!valid_leaf(name)) {
    free(name);
    free(mode_name);
    return throw_code(env, "EINVAL");
  }
  int flags;
  if (strcmp(mode_name, "CREATE_EXCLUSIVE") == 0) {
    flags = O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC;
  } else if (strcmp(mode_name, "CREATE_OR_OPEN") == 0) {
    flags = O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC;
  } else if (strcmp(mode_name, "OPEN_READ") == 0) {
    flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
  } else {
    free(name);
    free(mode_name);
    return throw_code(env, "NATIVE_ARGUMENT_INVALID");
  }
  int result = openat(parent, name, flags, (mode_t)mode);
  int error = errno;
  free(name);
  free(mode_name);
  if (result < 0) return throw_errno_value(env, error);
  struct stat facts;
  if (fstat(result, &facts) != 0 || !S_ISREG(facts.st_mode)) {
    error = errno == 0 ? EINVAL : errno;
    close(result);
    return throw_errno_value(env, error);
  }
  return fd_value(env, result);
}

static napi_value close_fd(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  if (close(descriptor) != 0) return throw_errno_value(env, errno);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value duplicate_fd(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  int result = dup(descriptor);
  return result < 0 ? throw_errno_value(env, errno) : fd_value(env, result);
}

static napi_value fsync_fd(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  if (fsync(descriptor) != 0) return throw_errno_value(env, errno);
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  if (!get_arguments(env, info, 3, arguments)) return NULL;
  int parent;
  uint32_t mode;
  if (!get_fd(env, arguments[0], &parent) ||
      napi_get_value_uint32(env, arguments[2], &mode) != napi_ok || mode > 0777) return NULL;
  char *name = get_string(env, arguments[1]);
  if (name == NULL) return NULL;
  if (!valid_leaf(name)) {
    free(name);
    return throw_code(env, "EINVAL");
  }
  int result = mkdirat(parent, name, (mode_t)mode);
  int error = errno;
  free(name);
  if (result != 0) return throw_errno_value(env, error);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static bool get_two_locations(
    napi_env env,
    napi_value *arguments,
    int *source_parent,
    char **source_name,
    int *target_parent,
    char **target_name) {
  if (!get_fd(env, arguments[0], source_parent) || !get_fd(env, arguments[2], target_parent)) {
    return false;
  }
  *source_name = get_string(env, arguments[1]);
  *target_name = get_string(env, arguments[3]);
  if (*source_name == NULL || *target_name == NULL) return false;
  if (!valid_leaf(*source_name) || !valid_leaf(*target_name)) {
    throw_code(env, "EINVAL");
    return false;
  }
  return true;
}

static napi_value link_file_exclusive_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  if (!get_arguments(env, info, 4, arguments)) return NULL;
  int source_parent, target_parent;
  char *source_name = NULL, *target_name = NULL;
  if (!get_two_locations(
          env, arguments, &source_parent, &source_name, &target_parent, &target_name)) {
    free(source_name);
    free(target_name);
    return NULL;
  }
  struct stat facts;
  if (fstatat(source_parent, source_name, &facts, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(facts.st_mode)) {
    int error = errno == 0 ? EINVAL : errno;
    free(source_name);
    free(target_name);
    return throw_errno_value(env, error);
  }
  int result = linkat(source_parent, source_name, target_parent, target_name, 0);
  int error = errno;
  free(source_name);
  free(target_name);
  if (result != 0) return throw_errno_value(env, error);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value rename_exclusive_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  if (!get_arguments(env, info, 4, arguments)) return NULL;
  int source_parent, target_parent;
  char *source_name = NULL, *target_name = NULL;
  if (!get_two_locations(
          env, arguments, &source_parent, &source_name, &target_parent, &target_name)) {
    free(source_name);
    free(target_name);
    return NULL;
  }
  int result = renameatx_np(source_parent, source_name, target_parent, target_name, RENAME_EXCL);
  int error = errno;
  free(source_name);
  free(target_name);
  if (result != 0) return throw_errno_value(env, error);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value rename_replace_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  if (!get_arguments(env, info, 4, arguments)) return NULL;
  int source_parent, target_parent;
  char *source_name = NULL, *target_name = NULL;
  if (!get_two_locations(
          env, arguments, &source_parent, &source_name, &target_parent, &target_name)) {
    free(source_name);
    free(target_name);
    return NULL;
  }
  int result = renameat(source_parent, source_name, target_parent, target_name);
  int error = errno;
  free(source_name);
  free(target_name);
  if (result != 0) return throw_errno_value(env, error);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value stat_object(napi_env env, const struct stat *facts) {
  const char *kind = S_ISREG(facts->st_mode) ? "FILE" :
                     S_ISDIR(facts->st_mode) ? "DIRECTORY" :
                     S_ISLNK(facts->st_mode) ? "SYMLINK" : "OTHER";
  char device[32];
  char inode[32];
  snprintf(device, sizeof(device), "%llu", (unsigned long long)facts->st_dev);
  snprintf(inode, sizeof(inode), "%llu", (unsigned long long)facts->st_ino);
  double modified_at_ms = ((double)facts->st_mtimespec.tv_sec * 1000.0) +
                          ((double)facts->st_mtimespec.tv_nsec / 1000000.0);
  napi_value object, kind_value, mode_value, size_value, links_value, device_value, inode_value,
      modified_at_value;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &kind_value) != napi_ok ||
      napi_create_uint32(env, (uint32_t)(facts->st_mode & 0777), &mode_value) != napi_ok ||
      napi_create_double(env, (double)facts->st_size, &size_value) != napi_ok ||
      napi_create_double(env, (double)facts->st_nlink, &links_value) != napi_ok ||
      napi_create_double(env, modified_at_ms, &modified_at_value) != napi_ok ||
      napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &device_value) != napi_ok ||
      napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &inode_value) != napi_ok ||
      napi_set_named_property(env, object, "kind", kind_value) != napi_ok ||
      napi_set_named_property(env, object, "mode", mode_value) != napi_ok ||
      napi_set_named_property(env, object, "sizeBytes", size_value) != napi_ok ||
      napi_set_named_property(env, object, "linkCount", links_value) != napi_ok ||
      napi_set_named_property(env, object, "modifiedAtMs", modified_at_value) != napi_ok ||
      napi_set_named_property(env, object, "device", device_value) != napi_ok ||
      napi_set_named_property(env, object, "inode", inode_value) != napi_ok) {
    return throw_code(env, "NATIVE_RESULT_FAILED");
  }
  return object;
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!get_arguments(env, info, 2, arguments)) return NULL;
  int parent;
  if (!get_fd(env, arguments[0], &parent)) return NULL;
  char *name = get_string(env, arguments[1]);
  if (name == NULL) return NULL;
  if (!valid_leaf(name)) {
    free(name);
    return throw_code(env, "EINVAL");
  }
  struct stat facts;
  int result = fstatat(parent, name, &facts, AT_SYMLINK_NOFOLLOW);
  int error = errno;
  free(name);
  if (result != 0) return throw_errno_value(env, error);
  return stat_object(env, &facts);
}

static napi_value stat_fd(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  struct stat facts;
  if (fstat(descriptor, &facts) != 0) return throw_errno_value(env, errno);
  return stat_object(env, &facts);
}

static napi_value read_directory_names(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  // A dup shares the directory stream offset and makes later validation observe an empty tree.
  int duplicated = openat(descriptor, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (duplicated < 0) return throw_errno_value(env, errno);
  DIR *directory = fdopendir(duplicated);
  if (directory == NULL) {
    int error = errno;
    close(duplicated);
    return throw_errno_value(env, error);
  }
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) {
    closedir(directory);
    return throw_code(env, "NATIVE_RESULT_FAILED");
  }
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_set_element(env, array, index, name) != napi_ok) {
      closedir(directory);
      return throw_code(env, "NATIVE_RESULT_FAILED");
    }
    index += 1;
  }
  int error = errno;
  closedir(directory);
  return error == 0 ? array : throw_errno_value(env, error);
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  if (!get_arguments(env, info, 3, arguments)) return NULL;
  int parent;
  if (!get_fd(env, arguments[0], &parent)) return NULL;
  char *name = get_string(env, arguments[1]);
  char *kind = get_string(env, arguments[2]);
  if (name == NULL || kind == NULL) {
    free(name);
    free(kind);
    return NULL;
  }
  if (!valid_leaf(name)) {
    free(name);
    free(kind);
    return throw_code(env, "EINVAL");
  }
  struct stat facts;
  if (fstatat(parent, name, &facts, AT_SYMLINK_NOFOLLOW) != 0) {
    int error = errno;
    free(name);
    free(kind);
    return throw_errno_value(env, error);
  }
  int flags;
  if (strcmp(kind, "FILE") == 0 && S_ISREG(facts.st_mode)) {
    flags = 0;
  } else if (strcmp(kind, "DIRECTORY") == 0 && S_ISDIR(facts.st_mode)) {
    flags = AT_REMOVEDIR;
  } else {
    free(name);
    free(kind);
    return throw_code(env, "EINVAL");
  }
  int result = unlinkat(parent, name, flags);
  int error = errno;
  free(name);
  free(kind);
  if (result != 0) return throw_errno_value(env, error);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value lock_file(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  int result = flock(descriptor, LOCK_EX | LOCK_NB);
  if (result != 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) {
    napi_value value;
    napi_get_boolean(env, false, &value);
    return value;
  }
  if (result != 0) return throw_errno_value(env, errno);
  napi_value value;
  napi_get_boolean(env, true, &value);
  return value;
}

static napi_value unlock_file(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  int descriptor;
  if (!get_arguments(env, info, 1, arguments) || !get_fd(env, arguments[0], &descriptor)) {
    return NULL;
  }
  if (flock(descriptor, LOCK_UN) != 0) return throw_errno_value(env, errno);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static bool export_function(
    napi_env env,
    napi_value exports,
    const char *name,
    napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

static napi_value initialize(napi_env env, napi_value exports) {
  if (!export_function(env, exports, "openSecureDirectory", open_secure_directory) ||
      !export_function(env, exports, "openDirectoryAt", open_directory_at) ||
      !export_function(env, exports, "openFileAt", open_file_at) ||
      !export_function(env, exports, "closeFd", close_fd) ||
      !export_function(env, exports, "duplicateFd", duplicate_fd) ||
      !export_function(env, exports, "fsyncFd", fsync_fd) ||
      !export_function(env, exports, "mkdirAt", mkdir_at) ||
      !export_function(env, exports, "linkFileExclusiveAt", link_file_exclusive_at) ||
      !export_function(env, exports, "renameExclusiveAt", rename_exclusive_at) ||
      !export_function(env, exports, "renameReplaceAt", rename_replace_at) ||
      !export_function(env, exports, "statAt", stat_at) ||
      !export_function(env, exports, "statFd", stat_fd) ||
      !export_function(env, exports, "readDirectoryNames", read_directory_names) ||
      !export_function(env, exports, "unlinkAt", unlink_at) ||
      !export_function(env, exports, "lockFileExclusiveNonblocking", lock_file) ||
      !export_function(env, exports, "unlockFile", unlock_file)) {
    return throw_code(env, "NATIVE_INITIALIZATION_FAILED");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
