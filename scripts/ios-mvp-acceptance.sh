#!/bin/zsh
set -euo pipefail

repo_root=${0:A:h:h}
developer_dir=${DEVELOPER_DIR:-/Applications/Xcode-26.5.0.app/Contents/Developer}
artifact_root=${IOS_MVP_ARTIFACT_ROOT:-$repo_root/ios-mvp-artifacts/final}
derived_data=${IOS_MVP_DERIVED_DATA:-$artifact_root/DerivedData}
run_count=${IOS_MVP_RUN_COUNT:-3}
device_type=${IOS_MVP_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}
runtime=${IOS_MVP_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}
simulator_udid=""

if [[ ! -x "$developer_dir/usr/bin/xcodebuild" ]]; then
  print -u2 "Xcode developer directory is unavailable: $developer_dir"
  exit 2
fi

export DEVELOPER_DIR="$developer_dir"

cleanup() {
  if [[ "$simulator_udid" =~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' ]]; then
    xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_udid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$artifact_root"
simulator_udid=$(xcrun simctl create "Geode MVP Acceptance $$" "$device_type" "$runtime")
if [[ ! "$simulator_udid" =~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' ]]; then
  print -u2 "simctl returned an invalid simulator identifier"
  exit 3
fi

xcrun simctl boot "$simulator_udid"
xcrun simctl bootstatus "$simulator_udid" -b

run_number=1
while (( run_number <= run_count )); do
  result="$artifact_root/run-$run_number.xcresult"
  if [[ -e "$result" ]]; then
    print -u2 "Refusing to overwrite existing result bundle: $result"
    exit 4
  fi
  xcodebuild test \
    -project "$repo_root/ios/App/App.xcodeproj" \
    -scheme App \
    -derivedDataPath "$derived_data" \
    -destination "platform=iOS Simulator,id=$simulator_udid" \
    -only-testing:AppUITests/ManagedCoreUITests \
    -only-testing:AppUITests/LegacyManagedVaultMigrationTests \
    -resultBundlePath "$result" \
    CODE_SIGNING_ALLOWED=NO
  run_number=$((run_number + 1))
done
