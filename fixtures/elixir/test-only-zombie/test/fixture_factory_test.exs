defmodule Tob.FixtureFactoryTest do
  use ExUnit.Case

  # A zombie test: it exercises only Tob.FixtureFactory, which is itself
  # test-only — so this test exercises no production-alive code.
  test "build/0 returns a sample" do
    assert Tob.FixtureFactory.build().id == 1
  end
end
